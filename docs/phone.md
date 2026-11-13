# 手机控制

插件：`plugins/phone/`

操作真实的 Android / HarmonyOS / iOS 手机：读屏幕上的控件、点、输入、滑动、按键、截图。

## 三个平台一起做

只支持 Android 对用 iPhone 或华为的人是半个功能。但三个平台的能力**并不一样**，
这个插件不假装一样：

| 平台 | 工具链 | 能力 | 已知限制 |
|---|---|---|---|
| Android | `adb` | 全部：读树、点、滑、输入、按键、截图 | 需要开 USB 调试并授权本机 |
| HarmonyOS | `hdc` + `uitest` | 全部 | 输入文字需要焦点坐标：先 `phone_tap` 再 `phone_type` |
| iOS | WebDriverAgent | 读树、点、滑、输入、截图 | **只能 attach**，见下 |

### 为什么 iOS 只能 attach

真机上点击和读控件树都必须经过 WebDriverAgent，而 WDA 要用 Xcode 签一次名装到设备里。
这一步要 Apple 开发者账号、要用户在设备上手动信任证书——我们不去代劳，也不假装能代劳。

所以要用户自己做一次：

1. 用 Xcode 打开 `WebDriverAgent.xcodeproj`，给 `WebDriverAgentRunner` 配好签名
2. 在设备上跑 `WebDriverAgentRunner`
3. 记下 WDA 的地址，默认 `http://127.0.0.1:8100`，不是这个就设 `UH_WDA_URL`

然后本插件就能驱动这台 iPhone 了。

**模拟器不支持交互**：`simctl` 只能截图，不能可靠地点击，所以如实报不可用，不留灰按钮。

### 验证来源

命令不是凭记忆写的，都对照过官方/一手资料：

- HarmonyOS：`hdc shell uitest dumpLayout [-p 路径]` 生成 JSON 控件树，
  `hdc shell uitest uiInput click|swipe|inputText|keyEvent` 注入操作，
  `hdc shell snapshot_display -f 路径` + `hdc file recv` 拿截图
- Android：`adb exec-out uiautomator dump /dev/tty` 出 XML，
  `adb shell input tap|swipe|text|keyevent`，`adb exec-out screencap -p`
- iOS：WDA 的 `/session`、`/session/<id>/source`、`/wda/tap/0`、`/wda/keys`、`/screenshot`

## 三端共用同一套逻辑

`plugins/shared/observe.js` 和 `plugins/phone/parse.js` 是共享的：

1. **归一化**：三个平台各自的控件树 → `{ role, name, flags, id }`
2. **增量观察**：ref 按 `role | name | 同类第几个` 稳定，界面刷新后同一个按钮还是同一个 ref
3. **事务化动作**：执行 → 等界面稳定 → 回读

所以模型在三个平台上看到的是同一种形状：`- button "确定" [ref=e3]`。

手机的观察器比浏览器多收一个 `text` 角色——手机界面上文字本身就是内容（菜单项、列表项），
而网页上 StaticText 遍地都是，收进来只会把上下文塞满。

## 解析时的取舍

- **不可见元素丢掉**：WDA 的 `visible="false"`、零尺寸的节点点不到，留着只会让模型对着
  不可见的东西发指令。
- **不可点的布局容器丢掉**：手机界面里大量 `View` / `FrameLayout` 只用来布局，
  全保留会把上下文塞满。可点的容器当按钮处理。
- **没名字但有身份的保留**：空输入框正是最需要看见的东西。
- **XML 实体必须反转义**：不做的话界面上 "Network & internet" 到模型眼里是
  "Network &amp; internet"，它照着这个名字找元素就会找错。这是个真 bug，测试钉住了。

## 工具

| 工具 | 作用 |
|---|---|
| `phone_status` | 三个平台分别报告可用性和**缺什么** |
| `phone_look` | 读当前屏幕，默认返回增量；`fresh: true` 全量 |
| `phone_tap` | 按 ref 点击，等稳定，报是否真的变化 |
| `phone_type` | 输入文字，然后回读屏幕确认 |
| `phone_swipe` | 两点之间滑动 |
| `phone_key` | back / home / enter / recents（iOS 只有 home） |
| `phone_screenshot` | 截图存盘 |

`platform` 参数可显式指定 `android` / `harmony` / `ios`；不指定时按 android → harmony → ios
的顺序挑第一个有设备的。

## 验证

```bash
node --test tests/phone.test.mjs
```

这台开发机上没有 adb / hdc / WDA，也没有设备，所以测试覆盖的是：

1. 三个平台的真实 dump 格式能解析成同一套节点（fixture 按官方输出格式构造）
2. 该丢的丢掉（不可见、零尺寸、不可点的布局容器）
3. 拿不到设备时报告的是**具体缺什么**，而不是一句"不可用"

"真的点了手机"这一步没法在这台机器上验证，需要一台连得上的设备。
`phone_status` 会如实告诉你现在缺什么。
