"""Actual main-app API; no companion APK or package-installer interaction."""
import subprocess,time,json,urllib.request,urllib.error,os
subprocess.run(['adb','forward','tcp:3738','tcp:3737'],check=True)
legacy=os.environ.get('SHELLPILOT_LEGACY_TEST')=='1'
if not legacy:assert 'package:app.shellpilot.workspace' not in subprocess.check_output(['adb','shell','pm','list','packages','app.shellpilot'],text=True)
subprocess.run(['adb','shell','am','start','-n','app.shellpilot.client/.MainActivity'],check=True)
base='http://127.0.0.1:3738/api'
def api(route,method='GET',body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(base+route,data=data,method=method,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=50) as response:return json.load(response)
    except Exception:
        print(subprocess.check_output(['adb','logcat','-d','-t','100'],text=True))
        raise
deadline=time.time()+35
while True:
    try:api('/settings');break
    except Exception:
        if time.time()>deadline:raise
        time.sleep(.3)
assert not api('/workspace/linux')['installed']
api('/workspace','PUT',{'directory':'/workspace','enabled':True,'engine':'linux','network':False})
api('/workspace/action','POST',{'name':'workspace_write','arguments':{'path':'before-install.txt','content':'file access without Linux'}})
assert api('/workspace/action','POST',{'name':'workspace_read','arguments':{'path':'before-install.txt'}})['content']=='file access without Linux'
api('/workspace/linux/install','POST',{})
deadline=time.time()+100
while True:
    state=api('/workspace/linux')
    assert state['phase']!='confirm-installation',state
    if state.get('error'):raise RuntimeError(state['error'])
    if state.get('installed'):break
    if time.time()>deadline:raise RuntimeError('Integrated rootfs installation timeout '+str(state))
    time.sleep(.4)
packages=subprocess.check_output(['adb','shell','pm','list','packages','app.shellpilot'],text=True)
if not legacy:assert 'package:app.shellpilot.workspace' not in packages
print('PASS: Linux rootfs downloads and extracts without package-installer activity or installing another app')
def action(name,args):return api('/workspace/action','POST',{'name':name,'arguments':args})
if legacy:
    assert action('workspace_read',{'path':'answer.txt'})['content']=='generated'
    assert action('workspace_read',{'path':'input.txt'})['content']=='fixture input'
    print('PASS: existing companion work files migrate into main app without deleting the old files')
result=action('workspace_exec',{'command':'cat before-install.txt; cat /etc/alpine-release; printf GENERATED > generated.txt','timeout':30000})
assert result['exitCode']==0 and '3.24.4' in result['stdout'] and 'file access without Linux' in result['stdout'],result
assert action('workspace_read',{'path':'generated.txt'})['content']=='GENERATED'
for command in ['cat /host-rootfs/data/data/app.shellpilot.client/files/settings.json','cat /host-rootfs/data/user/0/app.shellpilot.client/files/settings.json','cat /proc/1/environ','wget -T 3 -O - http://127.0.0.1:3737/api/settings']:
    result=action('workspace_exec',{'command':command,'timeout':6000})
    assert result['exitCode']!=0,result
api('/workspace/linux/stop','POST',{})
assert not api('/workspace/linux')['running']
assert action('workspace_read',{'path':'generated.txt'})['content']=='GENERATED'
api('/workspace/linux/uninstall','POST',{})
assert not api('/workspace/linux')['installed']
api('/workspace','PUT',{'directory':'/workspace','enabled':True,'engine':'linux','network':False})
assert action('workspace_read',{'path':'generated.txt'})['content']=='GENERATED'
api('/workspace/linux/install','POST',{})
deadline=time.time()+30
while not api('/workspace/linux')['installed']:
    assert time.time()<deadline
    time.sleep(.3)
print('PASS: integrated Alpine commands and files, loopback/private-path denial, restart and runtime uninstall preserve work files')
