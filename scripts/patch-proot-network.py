"""Pin Internet access in the tracer; traced commands cannot alter this policy."""
import pathlib,sys
source=pathlib.Path(sys.argv[1])/'src/syscall/enter.c'
text=source.read_text()
guard=r'''
static int shellpilot_address(Tracee *tracee, word_t address, word_t length) {
    struct sockaddr_storage storage;
    if (!address || length < sizeof(sa_family_t) || length > sizeof(storage)) return -EACCES;
    memset(&storage, 0, sizeof(storage));
    if (read_data(tracee, &storage, address, length) < 0) return -EACCES;
    if (!getenv("SHELLPILOT_NETWORK") || strcmp(getenv("SHELLPILOT_NETWORK"), "1")) return -EACCES;
    if (storage.ss_family == AF_INET) {
        uint32_t ip=ntohl(((struct sockaddr_in *)&storage)->sin_addr.s_addr);
        unsigned a=ip>>24,b=(ip>>16)&255;
        if (a==0||a==10||a==127||a>=224||(a==192&&b==168)||(a==172&&b>=16&&b<=31)||(a==169&&b==254)||(a==100&&b>=64&&b<=127)) return -EACCES;
        return 0;
    }
    if (storage.ss_family == AF_INET6) {
        const uint8_t *ip=((struct sockaddr_in6 *)&storage)->sin6_addr.s6_addr;
        if ((ip[0]&0xe0)!=0x20) return -EACCES;
        return 0;
    }
    return -EACCES;
}
'''
text=text.replace('int translate_syscall_enter(Tracee *tracee)',guard+'\nint translate_syscall_enter(Tracee *tracee)')
needle='syscall_number = get_sysnum(tracee, ORIGINAL);'
policy=r'''
    /* No host IPC, raw packets, io_uring or passing sockets around this check. */
    if (syscall_number == PR_socket) {
        word_t domain=peek_reg(tracee,CURRENT,SYSARG_1);
        word_t type=peek_reg(tracee,CURRENT,SYSARG_2)&15;
        if ((domain!=AF_INET && domain!=AF_INET6) || (type!=SOCK_STREAM && type!=SOCK_DGRAM)) {status=-EACCES;goto end;}
    }
    if (syscall_number == PR_connect) {
        status=shellpilot_address(tracee,peek_reg(tracee,CURRENT,SYSARG_2),peek_reg(tracee,CURRENT,SYSARG_3));
        if(status<0)goto end;
    }
    if (syscall_number == PR_sendto && peek_reg(tracee,CURRENT,SYSARG_5)) {
        status=shellpilot_address(tracee,peek_reg(tracee,CURRENT,SYSARG_5),peek_reg(tracee,CURRENT,SYSARG_6));
        if(status<0)goto end;
    }
'''
# PRoot has portable syscall enumerations; only reference those present in its map.
sysnums=''.join(p.read_text(errors='ignore') for p in (source.parents[1]/'syscall').glob('*.h'))
for name in ['sendmsg','sendmmsg','socketcall','io_uring_setup']:
    # Enumerations are generated in sysnum.c from the syscall list.
    definitions=''.join(p.read_text(errors='ignore') for p in source.parents[1].rglob('*') if p.is_file() and p.suffix in ['.h','.c'])
    if 'PR_'+name in definitions:
        policy+='\nif(syscall_number==PR_'+name+'){status=-EACCES;goto end;}\n'
if text.count(needle)!=1:raise SystemExit('PRoot syscall hook changed')
source.write_text(text.replace(needle,needle+policy))
