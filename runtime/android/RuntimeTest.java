package app.shellpilot.workspace.test;
import android.app.Instrumentation;
import android.content.*;
import android.os.*;
import org.json.*;
import java.util.concurrent.*;
public final class RuntimeTest extends Instrumentation {
 public void onCreate(Bundle args){super.onCreate(args);start();}
 public void onStart(){Bundle result=new Bundle();try{
  Context context=getTargetContext();CountDownLatch latch=new CountDownLatch(1);final IBinder[] service=new IBinder[1];
  ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){service[0]=binder;latch.countDown();}public void onServiceDisconnected(ComponentName name){}};
  context.startForegroundService(new Intent().setComponent(new ComponentName("app.shellpilot.workspace","app.shellpilot.workspace.RuntimeService")));
  if(!context.bindService(new Intent().setComponent(new ComponentName("app.shellpilot.workspace","app.shellpilot.workspace.RuntimeService")),connection,Context.BIND_AUTO_CREATE)||!latch.await(10,TimeUnit.SECONDS))throw new Exception("Runtime bind failed");
  try{
   call(service[0],new JSONObject().put("op","prepare"));
   call(service[0],new JSONObject().put("op","action").put("name","workspace_write").put("arguments",new JSONObject().put("path","input.txt").put("content","fixture input")));
   JSONObject command=call(service[0],new JSONObject().put("op","action").put("name","workspace_exec").put("network",false).put("arguments",new JSONObject().put("command","cat input.txt; printf generated > answer.txt; cat /etc/alpine-release").put("timeout",30000)));
   if(command.getInt("exitCode")!=0||!command.getString("stdout").contains("fixture input")||!command.getString("stdout").contains("3.24.4"))throw new Exception(command.toString());
   JSONObject denied=call(service[0],new JSONObject().put("op","action").put("name","workspace_exec").put("network",true).put("arguments",new JSONObject().put("command","wget -T 3 -O - http://127.0.0.1:3737/api/settings").put("timeout",5000)));
   if(denied.getInt("exitCode")==0)throw new Exception("Loopback access was not denied");
   JSONObject outside=call(service[0],new JSONObject().put("op","action").put("name","workspace_exec").put("network",false).put("arguments",new JSONObject().put("command","cat /host-rootfs/data/local/tmp/shellpilot-private-canary").put("timeout",5000)));
   if(outside.getInt("exitCode")==0||outside.getString("stdout").contains("PRIVATE_CANARY"))throw new Exception("Outside file read was not denied");
   call(service[0],new JSONObject().put("op","terminal-open").put("network",false));call(service[0],new JSONObject().put("op","terminal-input").put("data","echo MANUAL_TERMINAL_OK\n"));Thread.sleep(600);
   JSONObject terminal=call(service[0],new JSONObject().put("op","terminal-output"));if(!terminal.getString("output").contains("MANUAL_TERMINAL_OK"))throw new Exception(terminal.toString());call(service[0],new JSONObject().put("op","terminal-close"));
   call(service[0],new JSONObject().put("op","uninstall"));
   // Removing the runtime must keep user outputs; preparing again is explicit.
   call(service[0],new JSONObject().put("op","prepare"));JSONObject file=call(service[0],new JSONObject().put("op","action").put("name","workspace_read").put("arguments",new JSONObject().put("path","answer.txt")));
   if(!file.getString("content").equals("generated"))throw new Exception("Uninstall lost user file");
   result.putString("stream","PASS: Android PRoot Alpine commands, file collaboration, private-file denial, loopback denial, manual terminal and uninstall preserves files\n");finish(-1,result);
  }finally{context.unbindService(connection);}
 }catch(Exception error){result.putString("stream","FAIL: "+error.toString()+"\n");finish(0,result);}}
 private JSONObject call(IBinder binder,JSONObject body)throws Exception{Parcel input=Parcel.obtain(),output=Parcel.obtain();try{input.writeString(body.toString());input.writeInt(0);if(!binder.transact(1,input,output,0))throw new Exception("Binder call failed");output.readException();JSONObject result=new JSONObject(output.readString());if(result.has("error"))throw new Exception(result.getString("error"));return result;}finally{input.recycle();output.recycle();}}
}
