package app.shellpilot.client.test;
import android.app.Instrumentation;
import android.content.*;
import android.os.*;
import java.io.*;
import java.util.concurrent.*;
import org.json.*;
public final class IntegratedRuntimeTest extends Instrumentation{
 public void onCreate(Bundle args){super.onCreate(args);start();}
 public void onStart(){Bundle report=new Bundle();try{
  Context context=getTargetContext();CountDownLatch latch=new CountDownLatch(1);final IBinder[] service=new IBinder[1];
  ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){service[0]=binder;latch.countDown();}public void onServiceDisconnected(ComponentName name){}};
  Intent intent=new Intent().setComponent(new ComponentName("app.shellpilot.client","app.shellpilot.client.IntegratedWorkspaceService"));
  if(!context.bindService(intent,connection,Context.BIND_AUTO_CREATE)||!latch.await(8,TimeUnit.SECONDS))throw new Exception("Internal workspace bind failed");
  File canary=new File(context.getFilesDir(),"app-private-canary.txt");
  try{try(OutputStream output=new FileOutputStream(canary)){output.write("PRIVATE_CREDENTIAL_CANARY".getBytes("UTF-8"));}
   String[] probes={"cat /host-rootfs"+canary.getPath(),"cat /proc/self/root"+canary.getPath(),"ln -s /host-rootfs"+canary.getPath()+" denied-link; cat denied-link","cat /dev/binder","kill -0 "+android.os.Process.myPid()};
   for(String probe:probes){JSONObject result=call(service[0],new JSONObject().put("op","action").put("name","workspace_exec").put("network",true).put("arguments",new JSONObject().put("command",probe).put("timeout",5000)));if(result.optInt("exitCode",0)==0||result.optString("stdout").contains("PRIVATE_CREDENTIAL_CANARY"))throw new Exception("Boundary probe escaped: "+probe+" "+result.toString());}
   JSONObject result=call(service[0],new JSONObject().put("op","action").put("name","workspace_exec").put("arguments",new JSONObject().put("command","printf OK > allowed.txt; cat allowed.txt; cat /etc/alpine-release").put("timeout",5000)));
   if(result.getInt("exitCode")!=0||!result.getString("stdout").contains("OK")||!result.getString("stdout").contains("3.24.4"))throw new Exception(result.toString());
   report.putString("stream","PASS: main-app credential canary exists and stays inaccessible through host-rootfs, proc-root, symlink and Binder; valid Linux files still work\n");finish(-1,report);
  }finally{canary.delete();context.unbindService(connection);}
 }catch(Exception error){report.putString("stream","FAIL: "+error.toString()+"\n");finish(0,report);}}
 private JSONObject call(IBinder binder,JSONObject body)throws Exception{Parcel input=Parcel.obtain(),output=Parcel.obtain();try{input.writeString(body.toString());input.writeInt(0);binder.transact(1,input,output,0);output.readException();JSONObject value=new JSONObject(output.readString());if(value.has("error"))throw new Exception(value.getString("error"));return value;}finally{input.recycle();output.recycle();}}
}
