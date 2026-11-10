#define _GNU_SOURCE
#include <sched.h>
#include <signal.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>

static int child(void *path) {
    int fd=open((char *)path,O_RDONLY);
    if(fd>=0){close(fd);return 55;}
    return 0;
}
int main(int argc,char **argv) {
    if(argc!=2)return 2;
    char *stack=malloc(65536);if(!stack)return 3;
    errno=0;
    int pid=clone(child,stack+65536,CLONE_UNTRACED|SIGCHLD,argv[1]);
    if(pid>=0){int status;waitpid(pid,&status,0);fprintf(stderr,"untraced clone was allowed\n");return 4;}
    if(errno!=EACCES&&errno!=EPERM){fprintf(stderr,"unexpected clone failure %d\n",errno);return 5;}
#ifdef SYS_clone3
    struct {uint64_t flags,pidfd,child_tid,parent_tid,exit_signal,stack,stack_size,tls,set_tid,set_tid_size,cgroup;} args={0};
    args.flags=CLONE_UNTRACED;args.exit_signal=SIGCHLD;
    errno=0;pid=syscall(SYS_clone3,&args,sizeof(args));
    if(pid==0)_exit(child(argv[1]));
    if(pid>0){int status;waitpid(pid,&status,0);fprintf(stderr,"untraced clone3 was allowed\n");return 6;}
    if(errno!=ENOSYS&&errno!=EACCES&&errno!=EPERM)return 7;
#endif
    pid=fork();if(pid==0)_exit(child(argv[1]));if(pid<0)return 8;
    int status=0;if(waitpid(pid,&status,0)<0||!WIFEXITED(status)||WEXITSTATUS(status)!=0)return 9;
    puts("CHILD_PATH_POLICY_OK");free(stack);return 0;
}
