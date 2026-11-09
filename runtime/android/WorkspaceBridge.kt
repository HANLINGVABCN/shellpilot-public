package app.shellpilot.client
import android.app.Activity
import android.content.*
import android.net.Uri
import android.os.*
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object WorkspaceBridge {
 private const val runtimePackage="app.shellpilot.workspace"
 fun request(activity:Activity,text:String):String { return try{
  val body=JSONObject(text)
  val op=body.optString("op")
  val installed=try{activity.packageManager.getPackageInfo(runtimePackage,0);true}catch(_:Exception){false}
  if(!installed&&op=="status")return JSONObject().put("installed",false).toString()
  if(!installed&&op=="install"){
   val file=File(body.getString("path"))
   val uri=FileProvider.getUriForFile(activity,"app.shellpilot.client.workspace-files",file)
   activity.runOnUiThread{activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))}
   return JSONObject().put("confirmationRequired",true).toString()
  }
  if(!installed)throw IllegalStateException("请先安装Linux运行组件")
  if(op=="install")body.put("op","prepare")
  val latch=CountDownLatch(1);var binder:IBinder?=null
  activity.startForegroundService(Intent().setComponent(ComponentName(runtimePackage,"$runtimePackage.RuntimeService")))
  val connection=object:ServiceConnection{
   override fun onServiceConnected(name:ComponentName,service:IBinder){binder=service;latch.countDown()}
   override fun onServiceDisconnected(name:ComponentName){binder=null}
  }
  if(!activity.bindService(Intent().setComponent(ComponentName(runtimePackage,"$runtimePackage.RuntimeService")),connection,Context.BIND_AUTO_CREATE))throw IllegalStateException("Linux运行组件无法连接")
  try{
   if(!latch.await(8,TimeUnit.SECONDS))throw IllegalStateException("Linux运行组件连接超时")
   val input=Parcel.obtain();val output=Parcel.obtain();var descriptor:ParcelFileDescriptor?=null
   try{
    if(op=="import"||op=="export")descriptor=ParcelFileDescriptor.open(File(body.getString("localPath")),if(op=="import")ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE)
    input.writeString(body.toString());input.writeInt(if(descriptor==null)0 else 1);descriptor?.writeToParcel(input,0)
    if(binder?.transact(1,input,output,0)!=true)throw IllegalStateException("Linux运行组件调用失败")
    output.readException();output.readString()?:"{}"
   }finally{descriptor?.close();input.recycle();output.recycle()}
  }finally{activity.unbindService(connection)}
 }catch(error:Exception){JSONObject().put("error",error.message?:"安卓工作区操作失败").toString()} }
}
