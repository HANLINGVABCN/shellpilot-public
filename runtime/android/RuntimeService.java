package app.shellpilot.workspace;
import android.app.Service;
import android.content.Intent;
import android.os.*;
import org.json.*;
import java.io.*;
import java.lang.Process;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Independent Android UID; no model/SSH credentials are copied into this app. */
public final class RuntimeService extends Service {
 private File root,files;
 private Process terminal;
 private final Set<Process> processes=ConcurrentHashMap.newKeySet();
 private final ByteArrayOutputStream terminalOutput=new ByteArrayOutputStream();
 private final ExecutorService workers=Executors.newCachedThreadPool();
 private final Object prepareLock=new Object();
 private final Binder binder=new Binder(){protected boolean onTransact(int code,Parcel input,Parcel output,int flags)throws RemoteException{
  if(code!=1)return super.onTransact(code,input,output,flags);
  if(Binder.getCallingUid()!=android.os.Process.myUid())enforceCallingPermission("app.shellpilot.workspace.ACCESS","ShellPilot signature required");
  try{
   JSONObject body=new JSONObject(input.readString());ParcelFileDescriptor descriptor=input.readInt()==1?ParcelFileDescriptor.CREATOR.createFromParcel(input):null;
   JSONObject result;
   try{result=dispatch(body,descriptor);}finally{if(descriptor!=null)descriptor.close();}
   output.writeNoException();output.writeString(result.toString());
  }catch(Exception error){output.writeNoException();output.writeString("{\"error\":"+JSONObject.quote(error.getMessage()==null?error.getClass().getSimpleName():error.getMessage())+"}");}return true;
 }};
 public IBinder onBind(Intent intent){return binder;}
 public void onCreate(){super.onCreate();root=new File(getFilesDir(),"linux");files=new File(getFilesDir(),"workspace");files.mkdirs();}
 public int onStartCommand(Intent intent,int flags,int id){android.app.NotificationManager manager=(android.app.NotificationManager)getSystemService(NOTIFICATION_SERVICE);manager.createNotificationChannel(new android.app.NotificationChannel("workspace","Linux工作区",android.app.NotificationManager.IMPORTANCE_LOW));startForeground(1,new android.app.Notification.Builder(this,"workspace").setSmallIcon(android.R.drawable.ic_menu_manage).setContentTitle("ShellPilot Linux 工作区").setContentText("本机文件与运行环境").build());return START_NOT_STICKY;}
 public void onDestroy(){stopAll();workers.shutdownNow();super.onDestroy();}
 private JSONObject dispatch(JSONObject body,ParcelFileDescriptor fd)throws Exception{
  String op=body.optString("op");
  if(op.equals("status"))return new JSONObject().put("installed",new File(root,"bin/sh").exists()).put("running",terminal!=null&&terminal.isAlive());
  if(op.equals("prepare")||op.equals("start")){prepare();return new JSONObject().put("installed",true).put("running",true);}
  if(op.equals("stop")){stopAll();return new JSONObject().put("stopped",true);}
  if(op.equals("uninstall")){stopAll();deleteTree(root);return new JSONObject().put("uninstalled",true).put("filesPreserved",true);}
  if(op.equals("import")||op.equals("export")){
   File file=resolve(body.getString("path"),op.equals("import"));
   if(fd==null)throw new IOException("Missing file descriptor");
   if(op.equals("import")){if(file.exists())throw new IOException("文件已存在");File temp=new File(file.getParentFile(),".upload-"+UUID.randomUUID());try(InputStream in=new FileInputStream(fd.getFileDescriptor());OutputStream out=new FileOutputStream(temp)){copy(in,out,1024L*1024*1024);}if(!temp.renameTo(file))throw new IOException("保存上传文件失败");}
   else{try(InputStream in=new FileInputStream(file);OutputStream out=new FileOutputStream(fd.getFileDescriptor())){copy(in,out,1024L*1024*1024);}}
   return new JSONObject().put("ok",true);
  }
  if(op.equals("terminal-open")){prepare();if(terminal!=null&&terminal.isAlive())throw new IOException("终端已打开");terminalOutput.reset();terminal=launch("exec /bin/sh -i",body.optBoolean("network",false));readAsync(terminal.getInputStream(),terminalOutput,256*1024);readAsync(terminal.getErrorStream(),terminalOutput,256*1024);return new JSONObject().put("opened",true);}
  if(op.equals("terminal-input")){if(terminal==null)throw new IOException("终端未打开");terminal.getOutputStream().write(body.getString("data").getBytes(StandardCharsets.UTF_8));terminal.getOutputStream().flush();return new JSONObject().put("ok",true);}
  if(op.equals("terminal-output")){synchronized(terminalOutput){String text=terminalOutput.toString("UTF-8");terminalOutput.reset();return new JSONObject().put("output",text).put("closed",terminal==null||!terminal.isAlive());}}
  if(op.equals("terminal-close")){if(terminal!=null){terminate(terminal);terminal=null;}return new JSONObject().put("closed",true);}
  if(!op.equals("action"))throw new IOException("Unknown runtime operation");
  prepare();JSONObject args=body.optJSONObject("arguments");if(args==null)args=new JSONObject();String name=body.getString("name");String path=args.optString("path","");
  if(name.equals("workspace_exec"))return execute(args.getString("command"),body.optBoolean("network",false),Math.max(100,Math.min(900000,args.optLong("timeout",120000))));
  File target=resolve(path,name.equals("workspace_write")||name.equals("workspace_mkdir"));
  if(name.equals("workspace_list")){JSONArray entries=new JSONArray();File[] list=target.listFiles();if(list==null)throw new IOException("无法列出目录");Arrays.sort(list,Comparator.comparing(File::getName));for(File item:list){if(item.getName().startsWith(".upload-"))continue;entries.put(new JSONObject().put("name",item.getName()).put("directory",item.isDirectory()).put("size",item.length()));if(entries.length()>=2000)break;}return new JSONObject().put("entries",entries).put("path",path);}
  if(name.equals("workspace_read")){if(target.length()>1024*1024)throw new IOException("文本文件超过1MB，请下载处理");byte[] bytes=readBytes(target);return new JSONObject().put("path",path).put("content",new String(bytes,StandardCharsets.UTF_8)).put("sha256",hash(bytes));}
  if(name.equals("workspace_write")){byte[] bytes=args.getString("content").getBytes(StandardCharsets.UTF_8);if(bytes.length>1024*1024)throw new IOException("单次写入超过1MB");String expected=target.exists()?hash(readBytes(target)):"missing";if(args.has("expectedHash")&&!expected.equals(args.getString("expectedHash")))throw new IOException("文件已变化，请重新读取后保存");File temp=new File(target.getParentFile(),".upload-"+UUID.randomUUID());try(OutputStream out=new FileOutputStream(temp)){out.write(bytes);}if(!temp.renameTo(target))throw new IOException("文件保存失败");return new JSONObject().put("written",true).put("sha256",hash(bytes));}
  if(name.equals("workspace_mkdir")){if(!target.mkdir())throw new IOException("目录创建失败");return new JSONObject().put("ok",true);}
  if(name.equals("workspace_delete")){if(target.equals(files)||!target.delete())throw new IOException("只能删除文件或空目录");return new JSONObject().put("ok",true);}
  throw new IOException("Unknown workspace tool");
 }
 private void prepare()throws Exception{synchronized(prepareLock){if(new File(root,"bin/sh").exists())return;root.mkdirs();File archive=new File(getCacheDir(),"rootfs.tar.gz");try(InputStream in=getAssets().open("rootfs.tar.gz");OutputStream out=new FileOutputStream(archive)){copy(in,out,32L*1024*1024);}Process unpack=new ProcessBuilder("/system/bin/toybox","tar","-xzf",archive.getAbsolutePath(),"-C",root.getAbsolutePath()).start();if(!unpack.waitFor(30,TimeUnit.SECONDS)||unpack.exitValue()!=0){unpack.destroyForcibly();throw new IOException("Linux解压失败");}archive.delete();new File(root,"workspace").mkdirs();new File(root,"tmp").mkdirs();try(OutputStream out=new FileOutputStream(new File(root,"etc/resolv.conf"))){out.write("nameserver 1.1.1.1\nnameserver 8.8.8.8\n".getBytes(StandardCharsets.UTF_8));}}}
 private Process launch(String command,boolean network)throws Exception{
  ArrayList<String> argv=new ArrayList<>();String lib=getApplicationInfo().nativeLibraryDir;argv.add(lib+"/libproot_exec.so");Collections.addAll(argv,"--root-id","--link2symlink","--kill-on-exit","-r",root.getAbsolutePath(),"-b",files.getAbsolutePath()+":/workspace","-b","/dev","-b","/proc","-w","/workspace","/usr/bin/env","-i","HOME=/root","PATH=/usr/sbin:/usr/bin:/sbin:/bin","TERM=xterm-256color","LANG=C.UTF-8","/bin/sh","-c",command);
  ProcessBuilder builder=new ProcessBuilder(argv).directory(files);builder.environment().clear();builder.environment().put("PROOT_LOADER",lib+"/libproot_loader.so");builder.environment().put("PROOT_TMP_DIR",getCacheDir().getAbsolutePath());builder.environment().put("PROOT_NO_SECCOMP","1");builder.environment().put("SHELLPILOT_NETWORK",network?"1":"0");Process process=builder.start();processes.add(process);return process;
 }
 private JSONObject execute(String command,boolean network,long timeout)throws Exception{
  long start=System.currentTimeMillis();Process process=launch(command,network);ByteArrayOutputStream out=new ByteArrayOutputStream(),err=new ByteArrayOutputStream();Future<?> stdout=readAsync(process.getInputStream(),out,128*1024),stderr=readAsync(process.getErrorStream(),err,128*1024);process.getOutputStream().close();boolean timedOut=!process.waitFor(timeout,TimeUnit.MILLISECONDS);if(timedOut)terminate(process);stdout.get(5,TimeUnit.SECONDS);stderr.get(5,TimeUnit.SECONDS);processes.remove(process);
  JSONObject result=new JSONObject().put("exitCode",timedOut?-1:process.exitValue()).put("stdout",out.toString("UTF-8")).put("stderr",err.toString("UTF-8")).put("durationMs",System.currentTimeMillis()-start).put("sandbox","Android独立应用＋PRoot");if(timedOut)result.put("error","工作区命令超时");return result;
 }
 private Future<?> readAsync(InputStream input,ByteArrayOutputStream output,int limit){return workers.submit(()->{byte[] bytes=new byte[8192];try{int n;while((n=input.read(bytes))>=0){synchronized(output){int used=Math.min(n,limit-output.size());if(used>0)output.write(bytes,0,used);}}}catch(IOException ignored){}});}
 private void stopAll(){for(Process process:processes)terminate(process);processes.clear();terminal=null;}
 private void terminate(Process process){long pid=-1;try{java.lang.reflect.Field field=process.getClass().getDeclaredField("pid");field.setAccessible(true);pid=field.getLong(process);}catch(Exception ignored){}for(int attempt=0;attempt<8&&process.isAlive();attempt++){File[] proc=new File("/proc").listFiles();if(pid>0&&proc!=null)for(File entry:proc){try{String status=new String(readBytes(new File(entry,"status")),StandardCharsets.UTF_8);if(status.contains("TracerPid:\t"+pid+"\n"))android.system.Os.kill(Integer.parseInt(entry.getName()),9);}catch(Exception ignored){}}try{process.waitFor(100,TimeUnit.MILLISECONDS);}catch(InterruptedException ignored){}}process.destroyForcibly();}
 private File resolve(String path,boolean create)throws Exception{if(path.startsWith("/")||path.contains("\\")||path.contains(":"))throw new IOException("只能使用工作区相对路径");File target=new File(files,path).getCanonicalFile();String base=files.getCanonicalPath();if(!target.getPath().equals(base)&&!target.getPath().startsWith(base+"/"))throw new IOException("文件超出工作区");File cursor=files;for(String part:path.split("/")){if(part.equals(".."))throw new IOException("不能访问上级目录");cursor=new File(cursor,part);try{android.system.StructStat stat=android.system.Os.lstat(cursor.getPath());if(android.system.OsConstants.S_ISLNK(stat.st_mode)||stat.st_nlink>1&&!cursor.isDirectory())throw new IOException("不允许链接文件");}catch(android.system.ErrnoException error){if(!create)throw error;}}return target;}
 private static byte[] readBytes(File file)throws IOException{try(InputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream()){copy(in,out,4L*1024*1024);return out.toByteArray();}}
 private static String hash(byte[] bytes)throws Exception{byte[] digest=java.security.MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder text=new StringBuilder();for(byte b:digest)text.append(String.format("%02x",b&255));return text.toString();}
 private static void copy(InputStream in,OutputStream out,long limit)throws IOException{byte[] buffer=new byte[65536];long total=0;int n;while((n=in.read(buffer))>=0){total+=n;if(total>limit)throw new IOException("文件超过大小限制");out.write(buffer,0,n);}}
 private static void deleteTree(File file)throws IOException{if(java.nio.file.Files.isSymbolicLink(file.toPath())){java.nio.file.Files.delete(file.toPath());return;}if(file.isDirectory()){File[] children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child);}if(file.exists()&&!file.delete())throw new IOException("运行环境卸载失败");}
}
