/* Small PTY relay: the untrusted shell still runs through PRoot. */
#define _GNU_SOURCE
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <signal.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <dirent.h>
#include <string.h>
static volatile sig_atomic_t stopping;
static void stop(int signal){(void)signal;stopping=1;}
static void tracees(pid_t tracer){DIR *proc=opendir("/proc");if(!proc)return;struct dirent *entry;while((entry=readdir(proc))){pid_t pid=atoi(entry->d_name);if(pid<=0)continue;char path[128],line[256];snprintf(path,sizeof(path),"/proc/%d/status",pid);FILE *file=fopen(path,"r");if(!file)continue;while(fgets(line,sizeof(line),file)){int parent;if(sscanf(line,"TracerPid: %d",&parent)==1&&parent==tracer){kill(pid,SIGKILL);break;}}fclose(file);}closedir(proc);}
static int write_all(int fd,const char *data,size_t count){while(count){ssize_t n=write(fd,data,count);if(n<=0)return -1;data+=n;count-=n;}return 0;}
int main(int argc,char **argv){
 if(argc<4)return 2;int master=posix_openpt(O_RDWR|O_NOCTTY);if(master<0||grantpt(master)||unlockpt(master))return 3;
 const char *name=ptsname(master);if(!name)return 4;pid_t child=fork();if(child<0)return 5;
 if(child==0){setsid();int slave=open(name,O_RDWR);if(slave<0)_exit(6);ioctl(slave,TIOCSCTTY,0);dup2(slave,0);dup2(slave,1);dup2(slave,2);if(slave>2)close(slave);close(master);execv(argv[2],argv+2);_exit(7);}
 signal(SIGTERM,stop);signal(SIGINT,stop);signal(SIGHUP,stop);signal(SIGPIPE,SIG_IGN);
 unsigned short cols=0,rows=0;char bytes[8192];
 while(!stopping){
  FILE *size=fopen(argv[1],"r");if(size){int c,r;if(fscanf(size,"%d %d",&c,&r)==2&&c>=2&&c<=500&&r>=2&&r<=500&&(c!=cols||r!=rows)){struct winsize ws={.ws_row=r,.ws_col=c};ioctl(master,TIOCSWINSZ,&ws);cols=c;rows=r;}fclose(size);}
  struct pollfd streams[2]={{.fd=0,.events=POLLIN},{.fd=master,.events=POLLIN}};if(poll(streams,2,150)<0)continue;
  if(streams[0].revents&(POLLIN|POLLHUP)){ssize_t n=read(0,bytes,sizeof(bytes));if(n<=0||write_all(master,bytes,n)<0)break;}
  if(streams[1].revents&POLLIN){ssize_t n=read(master,bytes,sizeof(bytes));if(n<=0||write_all(1,bytes,n)<0)break;}
  if(streams[1].revents&(POLLHUP|POLLERR))break;
  int status;if(waitpid(child,&status,WNOHANG)==child){close(master);return WIFEXITED(status)?WEXITSTATUS(status):1;}
 }
 for(int n=0;n<8;n++){tracees(child);if(waitpid(child,0,WNOHANG)==child)break;usleep(100000);}kill(-child,SIGKILL);kill(child,SIGKILL);waitpid(child,0,0);close(master);return 0;
}
