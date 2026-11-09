#!/usr/bin/env bash
set -euo pipefail
version=3.24.4
archive=alpine-minirootfs-$version-x86_64.tar.gz
mkdir -p runtime-build/linux/root runtime-build/assets
curl --fail --location --retry 4 "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/$archive" -o "runtime-build/linux/$archive"
printf 'cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012  runtime-build/linux/%s\n' "$archive" | sha256sum --check
sudo tar -xzf "runtime-build/linux/$archive" -C runtime-build/linux/root
root=$(realpath runtime-build/linux/root)
sudo cp /etc/resolv.conf "$root/etc/resolv.conf"
sudo mount --bind /dev "$root/dev"
sudo mount -t proc proc "$root/proc"
sudo mount -t sysfs sys "$root/sys"
trap 'sudo umount "$root/dev" "$root/proc" "$root/sys" 2>/dev/null || true' EXIT
sudo chroot "$root" /sbin/apk add --no-cache linux-virt openssh openrc ca-certificates
sudo install -m 755 runtime/guest-init "$root/sbin/shellpilot-init"
sudo mkdir -p "$root/workspace" "$root/root/.ssh"
sudo chroot "$root" /usr/bin/ssh-keygen -A
sudo sed -i 's/^root:\*/root:!/' "$root/etc/shadow"
sudo tee "$root/etc/ssh/sshd_config" >/dev/null <<'SSH'
Port 22
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
Subsystem sftp internal-sftp
SSH
sudo umount "$root/dev" "$root/proc" "$root/sys"
trap - EXIT
sudo cp "$root/boot/vmlinuz-virt" runtime-build/assets/vmlinuz
sudo cp "$root/boot/initramfs-virt" runtime-build/assets/initramfs
truncate -s 1G runtime-build/assets/disk.raw
sudo mkfs.ext4 -q -F -d "$root" runtime-build/assets/disk.raw
qemu-img convert -f raw -O qcow2 -c runtime-build/assets/disk.raw runtime-build/assets/base.qcow2
sudo rm runtime-build/assets/disk.raw
sudo chown -R "$(id -u):$(id -g)" runtime-build/assets
cp runtime/README.md runtime-build/assets/RUNTIME-README.md
tar -czf runtime-build/ShellPilot-Linux-Guest.tar.gz -C runtime-build/assets .
