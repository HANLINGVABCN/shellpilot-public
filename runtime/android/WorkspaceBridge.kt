package app.shellpilot.client
import android.app.Activity
import android.content.*
import android.net.Uri
import android.os.*
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import android.provider.DocumentsContract
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object WorkspaceBridge {
 private const val runtimePackage="app.shellpilot.client"
 private const val runtimeService="app.shellpilot.client.IntegratedWorkspaceService"
 private var exportPath:String?=null
 private const val exportCode=41212
 private const val importCode=41213
 private var importTarget:String?=null
 private val importLock=Any()
 private var importState=JSONObject().put("phase","idle").put("files",0)
 fun result(activity:Activity,code:Int,result:Int,data:Intent?){
  if(code==importCode){
   val target=synchronized(importLock){val value=importTarget;importTarget=null;value}
   if(result!=Activity.RESULT_OK||data?.data==null||target==null){synchronized(importLock){importState=JSONObject().put("phase","cancelled").put("files",0)};return}
   Thread{try{
    synchronized(importLock){importState=JSONObject().put("phase","copying").put("files",0)}
    val uri=data.data!!;val document=DocumentsContract.buildDocumentUriUsingTree(uri,DocumentsContract.getTreeDocumentId(uri))
    importTree(activity,uri,document,target)
    synchronized(importLock){importState.put("phase","done")}
   }catch(error:Exception){synchronized(importLock){importState.put("phase","failed").put("error",error.message?:"文件夹上传失败")}}}.start()
   return
  }
  if(code!=exportCode)return
  val path=exportPath;exportPath=null
  if(result==Activity.RESULT_OK&&data?.data!=null&&path!=null){Thread{request(activity,JSONObject().put("op","export").put("path",path).put("outputUri",data.data.toString()).toString())}.start()}
 }
 fun request(activity:Activity,text:String):String { return try{
  val body=JSONObject(text)
  val op=body.optString("op")
  if(op=="user-import-status")return synchronized(importLock){importState.toString()}
  if(op=="user-import-directory"){
   synchronized(importLock){if(importState.optString("phase") in listOf("choosing","copying"))throw IllegalStateException("文件夹上传正在进行");importTarget=body.optString("path","");importState=JSONObject().put("phase","choosing").put("files",0)}
   activity.runOnUiThread{activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),importCode)}
   return JSONObject().put("pickerOpened",true).toString()
  }
  if(op=="user-export"){
   exportPath=body.getString("path")
   activity.runOnUiThread{activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,File(exportPath!!).name),exportCode)}
   return JSONObject().put("saveDialogOpened",true).toString()
  }
  val latch=CountDownLatch(1);var binder:IBinder?=null
  if(op!="status")activity.startForegroundService(Intent().setComponent(ComponentName(runtimePackage,runtimeService)))
  val connection=object:ServiceConnection{
   override fun onServiceConnected(name:ComponentName,service:IBinder){binder=service;latch.countDown()}
   override fun onServiceDisconnected(name:ComponentName){binder=null}
  }
  if(!activity.bindService(Intent().setComponent(ComponentName(runtimePackage,runtimeService)),connection,Context.BIND_AUTO_CREATE))throw IllegalStateException("Linux运行组件无法连接")
  try{
   if(!latch.await(8,TimeUnit.SECONDS))throw IllegalStateException("Linux运行组件连接超时")
   val input=Parcel.obtain();val output=Parcel.obtain();var descriptor:ParcelFileDescriptor?=null
   try{
    if(op=="import"&&body.has("inputUri"))descriptor=activity.contentResolver.openFileDescriptor(Uri.parse(body.getString("inputUri")),"r")
    else if(op=="export"&&body.has("outputUri"))descriptor=activity.contentResolver.openFileDescriptor(Uri.parse(body.getString("outputUri")),"w")
    else if(op=="install")descriptor=ParcelFileDescriptor.open(File(body.getString("path")),ParcelFileDescriptor.MODE_READ_ONLY)
    else if(op=="import"||op=="export")descriptor=ParcelFileDescriptor.open(File(body.getString("localPath")),if(op=="import")ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE)
    input.writeString(body.toString());input.writeInt(if(descriptor==null)0 else 1);descriptor?.writeToParcel(input,0)
    if(binder?.transact(1,input,output,0)!=true)throw IllegalStateException("Linux运行组件调用失败")
    output.readException();val value=JSONObject(output.readString()?:"{}")
    if(op=="install"&&!value.has("error")){value.put("migratedFiles",migrateLegacy(activity))}
    value.toString()
   }finally{descriptor?.close();input.recycle();output.recycle()}
  }finally{activity.unbindService(connection)}
 }catch(error:Exception){JSONObject().put("error",error.message?:"安卓工作区操作失败").toString()} }
 private fun invoke(activity:Activity,body:JSONObject):JSONObject{
  val value=JSONObject(request(activity,body.toString()));if(value.has("error"))throw IllegalStateException(value.getString("error"));return value
 }
 private fun legacy(activity:Activity,body:JSONObject,outputFile:File?=null):JSONObject{
  val intent=Intent().setComponent(ComponentName("app.shellpilot.workspace","app.shellpilot.workspace.RuntimeService"))
  val latch=CountDownLatch(1);var binder:IBinder?=null
  val connection=object:ServiceConnection{override fun onServiceConnected(name:ComponentName,service:IBinder){binder=service;latch.countDown()};override fun onServiceDisconnected(name:ComponentName){binder=null}}
  if(!activity.bindService(intent,connection,Context.BIND_AUTO_CREATE))throw IllegalStateException("旧工作区文件暂时无法读取，原文件保留")
  try{if(!latch.await(8,TimeUnit.SECONDS))throw IllegalStateException("旧工作区连接超时，原文件保留")
   val input=Parcel.obtain();val output=Parcel.obtain();var descriptor:ParcelFileDescriptor?=null
   try{if(outputFile!=null)descriptor=ParcelFileDescriptor.open(outputFile,ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE)
    input.writeString(body.toString());input.writeInt(if(descriptor==null)0 else 1);descriptor?.writeToParcel(input,0)
    if(binder?.transact(1,input,output,0)!=true)throw IllegalStateException("旧工作区文件读取失败，原文件保留")
    output.readException();val result=JSONObject(output.readString()?:"{}");if(result.has("error"))throw IllegalStateException(result.getString("error"));return result
   }finally{descriptor?.close();input.recycle();output.recycle()}
  }finally{activity.unbindService(connection)}
 }
 private fun migrateLegacy(activity:Activity):Int{
  val marker=File(activity.noBackupFilesDir,"legacy-workspace-migrated")
  if(marker.exists())return 0
  val present=try{activity.packageManager.getPackageInfo("app.shellpilot.workspace",0);true}catch(_:Exception){false}
  if(!present)return 0
  val directory=File(activity.filesDir,"workspace");var count=0
  fun copy(path:String){
   val items=legacy(activity,JSONObject().put("op","action").put("name","workspace_list").put("arguments",JSONObject().put("path",path))).getJSONArray("entries")
   for(index in 0 until items.length()){
    val item=items.getJSONObject(index);val name=item.getString("name");if(name.isEmpty()||name=="."||name==".."||name.contains('/')||name.contains('\\')||name.equals(".shellpilot",true))throw IllegalStateException("旧工作区包含无效路径，原文件保留")
    val relative=if(path.isEmpty())name else "$path/$name"
    val target=File(directory,relative)
    if(!target.canonicalPath.startsWith(directory.canonicalPath+"/")||java.nio.file.Files.isSymbolicLink(target.toPath()))throw IllegalStateException("新工作区路径发生变化，原文件保留")
    if(item.getBoolean("directory")){if(!target.exists())invoke(activity,JSONObject().put("op","action").put("name","workspace_mkdir").put("arguments",JSONObject().put("path",relative)));copy(relative)}
    else{
     val temp=File.createTempFile("legacy-",".tmp",File(activity.cacheDir,"workspace-migration").apply{mkdirs()})
     try{legacy(activity,JSONObject().put("op","export").put("path",relative),temp)
      fun hash(file:File):String{val digest=MessageDigest.getInstance("SHA-256");file.inputStream().use{input->val buffer=ByteArray(65536);while(true){val size=input.read(buffer);if(size<0)break;digest.update(buffer,0,size)}};return digest.digest().joinToString(""){"%02x".format(it)}}
      if(target.exists()){if(target.isFile&&hash(target)==hash(temp))continue;throw IllegalStateException("新旧工作区文件冲突：$relative，原文件均已保留")}
      invoke(activity,JSONObject().put("op","import").put("path",relative).put("localPath",temp.path));count++
     }finally{temp.delete()}
    }
   }
  }
  copy("");marker.writeText("migrated");return count
 }
 private fun importTree(activity:Activity,tree:Uri,document:Uri,parent:String){
  val projection=arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_DOCUMENT_ID)
  val details=activity.contentResolver.query(document,projection,null,null,null)?.use{cursor->if(!cursor.moveToFirst())throw IllegalStateException("无法读取文件夹");Triple(cursor.getString(0),cursor.getString(1),cursor.getString(2))}?:throw IllegalStateException("无法读取文件夹")
  val name=details.first
  if(name.isEmpty()||name in listOf(".","..")||name.equals(".shellpilot",true)||name.any{it.code<32||it in "/\\:<>\"|?*"}||name.endsWith(".")||name.endsWith(" "))throw IllegalStateException("文件名无效：$name")
  val path=if(parent.isEmpty())name else "$parent/$name"
  if(details.second==DocumentsContract.Document.MIME_TYPE_DIR){
   val list=invoke(activity,JSONObject().put("op","action").put("name","workspace_list").put("arguments",JSONObject().put("path",parent))).getJSONArray("entries")
   var exists=false
   for(index in 0 until list.length()){val entry=list.getJSONObject(index);if(entry.getString("name")==name){if(!entry.getBoolean("directory"))throw IllegalStateException("目录被文件占用：$path");exists=true}}
   if(!exists)invoke(activity,JSONObject().put("op","action").put("name","workspace_mkdir").put("arguments",JSONObject().put("path",path)))
   val children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,details.third)
   activity.contentResolver.query(children,arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID),null,null,null)?.use{cursor->while(cursor.moveToNext())importTree(activity,tree,DocumentsContract.buildDocumentUriUsingTree(tree,cursor.getString(0)),path)}?:throw IllegalStateException("无法读取子目录")
  }else{
   invoke(activity,JSONObject().put("op","import").put("path",path).put("inputUri",document.toString()))
   synchronized(importLock){importState.put("files",importState.optInt("files")+1)}
  }
 }
}
