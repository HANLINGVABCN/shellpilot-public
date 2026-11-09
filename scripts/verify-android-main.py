import subprocess,time,json,urllib.request
subprocess.run(['adb','forward','tcp:3738','tcp:3737'],check=True)
subprocess.run(['adb','uninstall','app.shellpilot.workspace'],check=True)
subprocess.run(['adb','shell','appops','set','app.shellpilot.client','REQUEST_INSTALL_PACKAGES','allow'],check=True)
subprocess.run(['adb','shell','am','start','-n','app.shellpilot.client/.MainActivity'],check=True)
base='http://127.0.0.1:3738/api'
def api(route,method='GET',body=None):
    data=None if body is None else json.dumps(body).encode()
    request=urllib.request.Request(base+route,data=data,method=method,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=40) as response:return json.load(response)
    except Exception:
        print(subprocess.check_output(['adb','logcat','-d','-t','120'],text=True))
        raise
deadline=time.time()+35
while True:
    try:api('/settings');break
    except Exception:
        if time.time()>deadline:raise
        time.sleep(.3)
api('/workspace/linux/install','POST',{})
deadline=time.time()+90
while True:
    state=api('/workspace/linux')
    if state.get('phase')=='confirm-installation':break
    if state.get('error'):raise RuntimeError(state['error'])
    if time.time()>deadline:raise RuntimeError('Runtime download/install URI timeout: '+str(state))
    time.sleep(.5)
subprocess.run(['adb','install','runtime-build/component/ShellPilot-Linux-Android-x86_64.apk'],check=True)
subprocess.run(['adb','shell','am','start','-n','app.shellpilot.client/.MainActivity'],check=True)
api('/workspace/linux/install','POST',{})
deadline=time.time()+35
while True:
    state=api('/workspace/linux')
    if state.get('installed'):break
    if state.get('error'):raise RuntimeError(state['error'])
    if time.time()>deadline:raise RuntimeError('Runtime preparation timeout')
    time.sleep(.3)
print('PASS: fresh Android runtime downloads only on install, verifies checksum, opens system installation URI and reuses cached component')
try:api('/workspace','PUT',{'directory':'/workspace','enabled':True,'engine':'linux','network':False})
except Exception:
    print(subprocess.check_output(['adb','logcat','-d','-t','120'],text=True))
    raise
api('/workspace/action','POST',{'name':'workspace_write','arguments':{'path':'main-fixture.txt','content':'main-app-file'}})
result=api('/workspace/action','POST',{'name':'workspace_exec','arguments':{'command':'cat main-fixture.txt; printf output > main-output.txt','timeout':30000}})
assert result['exitCode']==0 and 'main-app-file' in result['stdout'],result
value=api('/workspace/action','POST',{'name':'workspace_read','arguments':{'path':'main-output.txt'}})
assert value['content']=='output',value
with urllib.request.urlopen(base+'/workspace/download?path=main-output.txt',timeout=20) as response:assert response.read()==b'output'
boundary='shellpilot-fixture-boundary'
data=(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="uploaded.txt"\r\nContent-Type: application/octet-stream\r\n\r\nstreamed-upload\r\n--{boundary}--\r\n').encode()
request=urllib.request.Request(base+'/workspace/upload',data=data,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
with urllib.request.urlopen(request,timeout=20) as response:assert response.status==200
assert api('/workspace/action','POST',{'name':'workspace_read','arguments':{'path':'uploaded.txt'}})['content']=='streamed-upload'
print('PASS: main Android app JNI/Binder connects to signed Linux component; files, commands, upload and download work end to end')
manifest=json.dumps({'files':['folder/docs/readme.txt'],'directories':['folder/empty']})
data=(f'--{boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n{manifest}\r\n--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="readme.txt"\r\nContent-Type: application/octet-stream\r\n\r\nnested-folder-upload\r\n--{boundary}--\r\n').encode()
request=urllib.request.Request(base+'/workspace/upload',data=data,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
with urllib.request.urlopen(request,timeout=30) as response:assert response.status==200
assert api('/workspace/action','POST',{'name':'workspace_read','arguments':{'path':'folder/docs/readme.txt'}})['content']=='nested-folder-upload'
assert any(entry['name']=='empty' and entry['directory'] for entry in api('/workspace/files?path=folder')['entries'])
print('PASS: main Android folder upload preserves nested files and empty directories through JNI and file descriptors')
