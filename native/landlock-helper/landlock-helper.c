/*
 * landlock-helper —— 在 landlock LSM 下执行命令的最小 helper。
 *
 * 为什么需要独立二进制：
 *   Node 没有 landlock 的系统调用绑定，且 landlock 必须在 exec 之前
 *   于同一进程内施加，所以不能靠"事后检查"。这个小程序做完限制后
 *   execvp 目标命令，子进程自然继承。
 *
 * 用法：
 *   landlock-helper --probe                      打印内核 landlock ABI（0 = 不支持）
 *   landlock-helper [--ro DIR]... [--rw DIR]...
 *                   [--net none|any] -- CMD [ARGS...]
 *
 * 语义：
 *   --ro DIR   只读（含执行）该目录树；可重复
 *   --rw DIR   读写该目录树；可重复
 *   --net none 禁止 TCP bind/connect（需要 ABI >= 4；UDP 不受 landlock 管控）
 *   默认不添加任何路径规则，因此**必须**显式给出 --ro / 之类，否则连动态库都读不到。
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* ---- landlock 常量（自行定义，避免依赖内核头版本） ---- */
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#define SYS_landlock_add_rule 445
#define SYS_landlock_restrict_self 446
#endif

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1
#define LANDLOCK_RULE_NET_PORT 2

#define A_FS_EXECUTE     (1ULL << 0)
#define A_FS_WRITE_FILE  (1ULL << 1)
#define A_FS_READ_FILE   (1ULL << 2)
#define A_FS_READ_DIR    (1ULL << 3)
#define A_FS_REMOVE_DIR  (1ULL << 4)
#define A_FS_REMOVE_FILE (1ULL << 5)
#define A_FS_MAKE_CHAR   (1ULL << 6)
#define A_FS_MAKE_DIR    (1ULL << 7)
#define A_FS_MAKE_REG    (1ULL << 8)
#define A_FS_MAKE_SOCK   (1ULL << 9)
#define A_FS_MAKE_FIFO   (1ULL << 10)
#define A_FS_MAKE_BLOCK  (1ULL << 11)
#define A_FS_MAKE_SYM    (1ULL << 12)
#define A_FS_REFER      (1ULL << 13) /* ABI 2 */
#define A_FS_TRUNCATE   (1ULL << 14) /* ABI 3 */
#define A_FS_IOCTL_DEV  (1ULL << 15) /* ABI 5 */

#define A_NET_BIND_TCP    (1ULL << 0) /* ABI 4 */
#define A_NET_CONNECT_TCP (1ULL << 1) /* ABI 4 */

struct ruleset_attr {
  unsigned long long handled_access_fs;
  unsigned long long handled_access_net;
};

struct path_beneath_attr {
  unsigned long long allowed_access; /* 内核是 __u64，不是 u32 */
  int parent_fd;
} __attribute__((packed));

static int abi_version(void) {
  long v = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  return v < 0 ? 0 : (int)v;
}

/* 按 ABI 裁剪支持位：请求了不支持的位会被内核直接 EINVAL */
static unsigned long long fs_mask(int abi) {
  unsigned long long m = A_FS_EXECUTE | A_FS_WRITE_FILE | A_FS_READ_FILE | A_FS_READ_DIR |
                         A_FS_REMOVE_DIR | A_FS_REMOVE_FILE | A_FS_MAKE_CHAR | A_FS_MAKE_DIR |
                         A_FS_MAKE_REG | A_FS_MAKE_SOCK | A_FS_MAKE_FIFO | A_FS_MAKE_BLOCK |
                         A_FS_MAKE_SYM;
  if (abi >= 2) m |= A_FS_REFER;
  if (abi >= 3) m |= A_FS_TRUNCATE;
  if (abi >= 5) m |= A_FS_IOCTL_DEV;
  return m;
}

static int add_path(int ruleset_fd, const char *path, unsigned long long access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    /* 路径不存在就跳过：各发行版布局不同（/lib64 只在 x86_64 有） */
    if (errno == ENOENT || errno == ENOTDIR) return 0;
    fprintf(stderr, "landlock-helper: cannot open %s: %s\n", path, strerror(errno));
    return -1;
  }
  struct path_beneath_attr pb = { .allowed_access = access, .parent_fd = fd };
  int rc = (int)syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
  if (rc < 0) {
    fprintf(stderr, "landlock-helper: add_rule %s: %s\n", path, strerror(errno));
    close(fd);
    return -1;
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  int abi = abi_version();

  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    printf("%d\n", abi);
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    printf("landlock-helper 1.0 (abi %d)\n", abi);
    return 0;
  }

  const char *ro[32]; int nro = 0;
  const char *rw[32]; int nrw = 0;
  const char *deny[64]; int ndeny = 0;
  int net_none = 0;
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { i++; break; }
    if (strcmp(argv[i], "--ro") == 0 && i + 1 < argc) { if (nro < 32) ro[nro++] = argv[++i]; continue; }
    if (strcmp(argv[i], "--rw") == 0 && i + 1 < argc) { if (nrw < 32) rw[nrw++] = argv[++i]; continue; }
    if (strcmp(argv[i], "--deny") == 0 && i + 1 < argc) { if (ndeny < 64) deny[ndeny++] = argv[++i]; continue; }
    if (strcmp(argv[i], "--net") == 0 && i + 1 < argc) {
      net_none = (strcmp(argv[++i], "none") == 0);
      continue;
    }
    fprintf(stderr, "landlock-helper: unexpected argument %s\n", argv[i]);
    return 64;
  }
  if (i >= argc) {
    fprintf(stderr, "landlock-helper: missing command after --\n");
    return 64;
  }
  if (abi == 0) {
    fprintf(stderr, "landlock-helper: landlock not supported by this kernel\n");
    return 69; /* E_UNAVAILABLE */
  }

  struct ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = fs_mask(abi);
  if (net_none && abi >= 4) attr.handled_access_net = A_NET_BIND_TCP | A_NET_CONNECT_TCP;

  long fd = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (fd < 0) {
    fprintf(stderr, "landlock-helper: create_ruleset: %s\n", strerror(errno));
    return 70;
  }

  /* 只读：读 + 执行，不含任何写位 */
  unsigned long long ro_access = A_FS_READ_FILE | A_FS_READ_DIR | A_FS_EXECUTE;
  /* 读写：全部支持位（ABI 裁剪后的） */
  unsigned long long rw_access = attr.handled_access_fs;

  for (int k = 0; k < nro; k++) if (add_path((int)fd, ro[k], ro_access) != 0) return 71;
  for (int k = 0; k < nrw; k++) if (add_path((int)fd, rw[k], rw_access) != 0) return 71;

  /* --deny：给这条路径（及其子树）零权限。
     必须放在 --ro/--rw 之后：landlock 对嵌套路径取**最具体**的规则，
     所以「放行 $HOME、拒绝 $HOME/.ssh」是能成立的。这让「读 home」不再
     等于「把私钥交给模型」——而这正是我们之前把 home 整个关掉的原因。 */
  for (int k = 0; k < ndeny; k++) if (add_path((int)fd, deny[k], 0) != 0) return 71;

  /* /dev 必须可写：/dev/null、/dev/urandom 等的写操作需要 WRITE_FILE 权限，
     否则任何程序的重定向都会 EACCES。调用方已显式给了就不重复。 */
  int dev_given = 0;
  for (int k = 0; k < nrw; k++) if (strcmp(rw[k], "/dev") == 0) dev_given = 1;
  if (!dev_given) {
    struct stat st;
    if (stat("/dev", &st) == 0 && add_path((int)fd, "/dev", rw_access) != 0) return 71;
  }

  /* net none 时不添加任何 net 规则 => 全部 TCP bind/connect 被拒 */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "landlock-helper: no_new_privs: %s\n", strerror(errno));
    return 72;
  }
  if (syscall(SYS_landlock_restrict_self, fd, 0) != 0) {
    fprintf(stderr, "landlock-helper: restrict_self: %s\n", strerror(errno));
    return 73;
  }
  close((int)fd);

  execvp(argv[i], &argv[i]);
  fprintf(stderr, "landlock-helper: exec %s: %s\n", argv[i], strerror(errno));
  return 74;
}
