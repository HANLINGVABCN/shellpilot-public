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
 private var exportPath:String?=null
 private const val exportCode=41212
 fun result(activity:Activity,code:Int,result:Int,data:Intent?){
  if(code!=exportCode)return
  val path=exportPath;exportPath=null
  if(result==Activity.RESULT_OK&&data?.data!=null&&path!=null){Thread{request(activity,JSONObject().put("op","export").put("path",path).put("outputUri",data.data.toString()).toString())}.start()}
 }
 fun request(activity:Activity,text:String):String { return try{
  val body=JSONObject(text)
  val op=body.optString("op")
  if(op=="user-export"){
   exportPath=body.getString("path")
   activity.runOnUiThread{activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,File(exportPath!!).name),exportCode)}
   return JSONObject().put("saveDialogOpened",true).toString()
  }
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
  if(op!="status")activity.startForegroundService(Intent().setComponent(ComponentName(runtimePackage,"$runtimePackage.RuntimeService")))
  val connection=object:ServiceConnection{
   override fun onServiceConnected(name:ComponentName,service:IBinder){binder=service;latch.countDown()}
   override fun onServiceDisconnected(name:ComponentName){binder=null}
  }
  if(!activity.bindService(Intent().setComponent(ComponentName(runtimePackage,"$runtimePackage.RuntimeService")),connection,Context.BIND_AUTO_CREATE))throw IllegalStateException("Linux运行组件无法连接")
  try{
   if(!latch.await(8,TimeUnit.SECONDS))throw IllegalStateException("Linux运行组件连接超时")
   val input=Parcel.obtain();val output=Parcel.obtain();var descriptor:ParcelFileDescriptor?=null
   try{
    if(op=="export"&&body.has("outputUri"))descriptor=activity.contentResolver.openFileDescriptor(Uri.parse(body.getString("outputUri")),"w")
    else if(op=="import"||op=="export")descriptor=ParcelFileDescriptor.open(File(body.getString("localPath")),if(op=="import")ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE)
    input.writeString(body.toString());input.writeInt(if(descriptor==null)0 else 1);descriptor?.writeToParcel(input,0)
    if(binder?.transact(1,input,output,0)!=true)throw IllegalStateException("Linux运行组件调用失败")
    output.readException();output.readString()?:"{}"
   }finally{descriptor?.close();input.recycle();output.recycle()}
  }finally{activity.unbindService(connection)}
 }catch(error:Exception){JSONObject().put("error",error.message?:"安卓工作区操作失败").toString()} }
}
