"""Constrain translated paths and dangerous syscalls in the trusted tracer."""
import pathlib,sys
root=pathlib.Path(sys.argv[1])
path=root/'src/path/path.c'
text=path.read_text()
guard=r'''
static int shellpilot_prefix(const char *path,const char *root) {
    size_t n=root?strlen(root):0;
    return n && !strncmp(path,root,n) && (path[n]==0 || path[n]=='/');
}
static int shellpilot_allowed_path(Tracee *tracee,const char *path) {
    const char *root=getenv("SHELLPILOT_ROOT");
    if (!root) return 1;
    if (shellpilot_prefix(path,root) || shellpilot_prefix(path,getenv("SHELLPILOT_FILES")) ||
        shellpilot_prefix(path,getenv("SHELLPILOT_TMP")) || shellpilot_prefix(path,getenv("SHELLPILOT_LIB"))) return 1;
    if (shellpilot_prefix(path,"/system") || shellpilot_prefix(path,"/apex")) return 1;
    if (!strcmp(path,"/dev/null") || !strcmp(path,"/dev/zero") || !strcmp(path,"/dev/random") ||
        !strcmp(path,"/dev/urandom") || !strcmp(path,"/dev/tty")) return 1;
    if (!strcmp(path,"/proc") || !strcmp(path,"/proc/cpuinfo") || !strcmp(path,"/proc/meminfo") ||
        !strcmp(path,"/proc/stat") || !strcmp(path,"/proc/uptime") || !strcmp(path,"/proc/version")) return 1;
    char own[80];snprintf(own,sizeof(own),"/proc/%d/",tracee->pid);
    if (!strncmp(path,own,strlen(own))) {
        const char *leaf=path+strlen(own);
        return !strcmp(leaf,"stat") || !strcmp(leaf,"status") || !strcmp(leaf,"auxv") || !strcmp(leaf,"maps");
    }
    return 0;
}
'''
text=text.replace('int translate_path(Tracee *tracee, char result[PATH_MAX], int dir_fd,',guard+'\nint translate_path(Tracee *tracee, char result[PATH_MAX], int dir_fd,',1)
needle='status = notify_extensions(tracee, TRANSLATED_PATH, (intptr_t) result, 0);'
if text.count(needle)!=1:raise SystemExit('PRoot translated path hook changed')
text=text.replace(needle,'if (!shellpilot_allowed_path(tracee,result)) return -EACCES;\n\t'+needle)
if '#include <stdlib.h>' not in text:text='#include <stdlib.h>\n#include <stdio.h>\n'+text
path.write_text(text)
source=root/'src/syscall/enter.c';text=source.read_text()
definitions=''.join(p.read_text(errors='ignore') for p in (root/'src').rglob('*') if p.suffix in ['.h','.c'])
policy='\n    if (getenv("SHELLPILOT_ROOT")) {\n'
for name in ['ptrace','process_vm_readv','process_vm_writev','io_uring_setup','open_by_handle_at','name_to_handle_at','bpf','perf_event_open','userfaultfd','execveat','mount','umount2','pivot_root','chroot','setns','unshare']:
    if 'PR_'+name in definitions:policy+='        if (syscall_number==PR_'+name+'){status=-EACCES;goto end;}\n'
for name in ['kill','tkill','tgkill']:
    if 'PR_'+name in definitions:
        policy+='        if (syscall_number==PR_'+name+' && peek_reg(tracee,CURRENT,SYSARG_1)!=(word_t)tracee->pid){status=-EACCES;goto end;}\n'
policy+='    }\n'
needle='syscall_number = get_sysnum(tracee, ORIGINAL);'
if text.count(needle)!=1:raise SystemExit('PRoot syscall hook changed')
source.write_text(text.replace(needle,needle+policy,1))
