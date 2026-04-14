/**
 * sandbox/stub.c
 *
 * 透過 GCC/LD --wrap 機制，在連結層攔截危險系統呼叫。
 * 使用者程式呼叫 system("...") 時，實際會執行 __wrap_system()，
 * 回傳 -1 (errno=EPERM) 並印出警告，不會真正執行。
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <dlfcn.h>

#define BLOCKED(name) \
    fprintf(stderr, "\n[sandbox] %s() is blocked in this environment.\n", name); \
    errno = EPERM;

/* ══ Shell 執行 ════════════════════════════════════════════════════════════ */

int __wrap_system(const char *cmd) {
    fprintf(stderr,
        "\n[sandbox] system() is blocked in this environment.\n"
        "  Attempted command: %.200s\n",
        cmd ? cmd : "(null)");
    errno = EPERM;
    return -1;
}

FILE *__wrap_popen(const char *cmd, const char *type) {
    fprintf(stderr,
        "\n[sandbox] popen() is blocked in this environment.\n"
        "  Attempted command: %.200s\n",
        cmd ? cmd : "(null)");
    errno = EPERM;
    return NULL;
}

/* ══ exec 系列 ══════════════════════════════════════════════════════════════ */

int __wrap_execl(const char *path, const char *arg, ...) {
    BLOCKED("execl"); return -1;
}
int __wrap_execle(const char *path, const char *arg, ...) {
    BLOCKED("execle"); return -1;
}
int __wrap_execlp(const char *file, const char *arg, ...) {
    BLOCKED("execlp"); return -1;
}
int __wrap_execv(const char *path, char *const argv[]) {
    BLOCKED("execv"); return -1;
}
int __wrap_execvp(const char *file, char *const argv[]) {
    BLOCKED("execvp"); return -1;
}
int __wrap_execvpe(const char *file, char *const argv[], char *const envp[]) {
    BLOCKED("execvpe"); return -1;
}
int __wrap_execve(const char *filename, char *const argv[], char *const envp[]) {
    BLOCKED("execve"); return -1;
}

/* ══ 建立子程序 ══════════════════════════════════════════════════════════════ */

pid_t __wrap_fork(void) {
    BLOCKED("fork"); return -1;
}
pid_t __wrap_vfork(void) {
    BLOCKED("vfork"); return -1;
}

/* ══ 刪除檔案 / 目錄 ═════════════════════════════════════════════════════════ */

int __wrap_unlink(const char *path) {
    fprintf(stderr, "\n[sandbox] unlink() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_unlinkat(int dirfd, const char *path, int flags) {
    fprintf(stderr, "\n[sandbox] unlinkat() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_remove(const char *path) {
    fprintf(stderr, "\n[sandbox] remove() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_rmdir(const char *path) {
    fprintf(stderr, "\n[sandbox] rmdir() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}

/* ══ 重命名 / 移動 ══════════════════════════════════════════════════════════ */

int __wrap_rename(const char *oldpath, const char *newpath) {
    fprintf(stderr,
        "\n[sandbox] rename() is blocked: %.100s -> %.100s\n",
        oldpath ? oldpath : "(null)", newpath ? newpath : "(null)");
    errno = EPERM; return -1;
}
int __wrap_renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
    fprintf(stderr, "\n[sandbox] renameat() is blocked.\n");
    errno = EPERM; return -1;
}

/* ══ 建立目錄 ══════════════════════════════════════════════════════════════ */

int __wrap_mkdir(const char *path, mode_t mode) {
    fprintf(stderr, "\n[sandbox] mkdir() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_mkdirat(int dirfd, const char *path, mode_t mode) {
    fprintf(stderr, "\n[sandbox] mkdirat() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}

/* ══ 權限 / 擁有者 ══════════════════════════════════════════════════════════ */

int __wrap_chmod(const char *path, mode_t mode) {
    fprintf(stderr, "\n[sandbox] chmod() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_fchmod(int fd, mode_t mode) {
    BLOCKED("fchmod"); return -1;
}
int __wrap_chown(const char *path, uid_t owner, gid_t group) {
    fprintf(stderr, "\n[sandbox] chown() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_fchown(int fd, uid_t owner, gid_t group) {
    BLOCKED("fchown"); return -1;
}

/* ══ 符號連結 / 硬連結 ════════════════════════════════════════════════════════ */

int __wrap_symlink(const char *target, const char *linkpath) {
    fprintf(stderr,
        "\n[sandbox] symlink() is blocked: %.100s -> %.100s\n",
        target ? target : "(null)", linkpath ? linkpath : "(null)");
    errno = EPERM; return -1;
}
int __wrap_link(const char *oldpath, const char *newpath) {
    fprintf(stderr, "\n[sandbox] link() is blocked.\n");
    errno = EPERM; return -1;
}

/* ══ 截斷檔案 ══════════════════════════════════════════════════════════════ */

int __wrap_truncate(const char *path, off_t length) {
    fprintf(stderr, "\n[sandbox] truncate() is blocked: %.200s\n", path ? path : "(null)");
    errno = EPERM; return -1;
}
int __wrap_ftruncate(int fd, off_t length) {
    BLOCKED("ftruncate"); return -1;
}

/* ══ 動態載入惡意 .so ════════════════════════════════════════════════════════ */

void *__wrap_dlopen(const char *filename, int flags) {
    fprintf(stderr,
        "\n[sandbox] dlopen() is blocked: %.200s\n",
        filename ? filename : "(null)");
    errno = EPERM; return NULL;
}