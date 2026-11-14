//! 桌面壳的内核：拉起 sidecar（`uh serve`），窗口指向它。
//!
//! 设计上刻意做得很薄：UI 只有一份（CLI 里那张静态页），桌面端不重复实现任何
//! 业务逻辑，只负责「起进程 + 开窗口 + 退出时收拾干净」。这样 CLI 和桌面永远不会分叉。

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub struct Sidecar(pub Mutex<Option<CommandChild>>);

/// 与 CLI 默认端口一致；被占用时 sidecar 会报错，日志走 stderr
const PORT: u16 = 7878;

fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // 1) 启动 sidecar：内置的 uh 二进制自己起 HTTP 服务
            let port = PORT.to_string();
            let spawn = handle
                .shell()
                .sidecar("uh")
                // --force：上一次没被收拾干净的 sidecar 还占着 7878 时接管它。
                // 不加这一句的表现是「重开桌面端还是旧界面」，而代码是最新的
                .map(|c| c.args(["serve", "--port", port.as_str(), "--force"]))
                .and_then(|c| c.spawn());

            match spawn {
                Ok((mut rx, child)) => {
                    if let Ok(mut slot) = handle.state::<Sidecar>().0.lock() {
                        *slot = Some(child);
                    }
                    // sidecar 的 stderr 是排错唯一的窗口，转发出来
                    tauri::async_runtime::spawn(async move {
                        while let Some(ev) = rx.recv().await {
                            if let CommandEvent::Stderr(line) = ev {
                                eprintln!("[uh] {}", String::from_utf8_lossy(&line));
                            }
                        }
                    });
                }
                Err(err) => {
                    eprintln!("E_SIDECAR: failed to start bundled `uh`: {err}");
                }
            }

            // 2) 等端口通了再导航，避免白屏
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(20);
                    while Instant::now() < deadline {
                        if port_open(PORT) {
                            if let Ok(url) = format!("http://127.0.0.1:{PORT}/").parse() {
                                let _ = window.navigate(url);
                            }
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(120));
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the UnitHarness desktop shell");

    app.run(|handle, event| {
        // 3) 关窗即收拾：不能让 sidecar 变成孤儿进程占着端口
        if let RunEvent::Exit = event {
            // CommandChild::kill 消费 self，所以必须 take 出来
            if let Ok(mut slot) = handle.state::<Sidecar>().0.lock() {
                if let Some(child) = slot.take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
