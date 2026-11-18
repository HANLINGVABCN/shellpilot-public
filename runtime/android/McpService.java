package app.shellpilot.client;
import android.app.*;
import android.content.Intent;
import android.os.*;

/** Keep the main application process available to same-device MCP clients. */
public final class McpService extends Service {
 public static volatile boolean active=false;
 public IBinder onBind(Intent intent){return null;}
 public int onStartCommand(Intent intent,int flags,int id){
  NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
  if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel("mcp","MCP 连接服务",NotificationManager.IMPORTANCE_LOW));
  Notification.Builder notification=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,"mcp"):new Notification.Builder(this);
  notification.setSmallIcon(android.R.drawable.ic_menu_manage).setContentTitle("ShellPilot MCP").setContentText("HTTP / SSE 接口已开启，点击返回设置").setOngoing(true);
  Intent open=getPackageManager().getLaunchIntentForPackage(getPackageName());
  if(open!=null)notification.setContentIntent(PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE));
  startForeground(2,notification.build());active=true;return START_NOT_STICKY;
 }
 public void onDestroy(){active=false;stopForeground(true);super.onDestroy();}
}
