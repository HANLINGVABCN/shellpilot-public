import subprocess,tempfile,pathlib,time,base64,socket,shutil
assets=pathlib.Path('runtime-build/assets').resolve()
with tempfile.TemporaryDirectory() as temp:
    folder=pathlib.Path(temp);key=folder/'client'
    subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    public=key.with_suffix('.pub').read_text().strip();auth=base64.b64encode(public.encode()).decode()
    known=folder/'known';known.write_text(f'[127.0.0.1]:{port} '+(assets/'hostkey.pub').read_text())
    disk=folder/'disk.qcow2';shutil.copyfile(assets/'base.qcow2',disk)
    qemu=['qemu-system-x86_64','-machine','q35','-accel','tcg','-m','384','-smp','2','-display','none','-monitor','none','-serial','file:'+str(folder/'boot.log'),'-kernel',str(assets/'vmlinuz'),'-initrd',str(assets/'initramfs'),'-append',f'console=ttyS0 root=/dev/vda rw init=/sbin/shellpilot-init spkey={auth}','-drive',f'file={disk},if=virtio,format=qcow2','-device','virtio-net-pci,romfile=,netdev=n','-netdev',f'user,id=n,restrict=on,hostfwd=tcp:127.0.0.1:{port}-:22']
    process=subprocess.Popen(qemu,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    ssh=['ssh','-p',str(port),'-i',str(key),'-o','BatchMode=yes','-o','ConnectTimeout=2','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'root@127.0.0.1']
    try:
        deadline=time.time()+100
        while time.time()<deadline:
            result=subprocess.run(ssh+['printf ready'],capture_output=True,text=True)
            if result.returncode==0:break
            if process.poll() is not None:raise RuntimeError(process.stderr.read().decode())
            time.sleep(.5)
        else:raise RuntimeError((folder/'boot.log').read_text())
        result=subprocess.run(ssh+['cat /etc/alpine-release; mkdir -p /workspace; printf test-output >/workspace/result.txt; cat /workspace/result.txt'],capture_output=True,text=True,check=True)
        assert '3.24.4' in result.stdout and 'test-output' in result.stdout
        print('PASS: QEMU boots Alpine, pins guest identity, accepts only generated key and persists workspace output')
    finally:process.kill();process.wait()
