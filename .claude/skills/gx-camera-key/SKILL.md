---
name: gx-camera-key
description: Check the restricted camera-ai SSH key on the Cerbo GX and give the owner the command to add, rotate or revoke it. Use for camera mail key setup or camera SSH public-key errors.
---

# GX camera mail key

1. If live access was requested, find the working GX address and administrator key path in Claude's memory note `gx-access-and-tuya-devices`, or ask the owner. Never copy addresses or private keys into the repository.
2. Run only the read-only check after the GX reachability check:
   ```powershell
   .\scripts\gx-camera-key.ps1 -Check -GxHost $gx -KeyPath $adminKey
   ```
3. If the key is missing, give the owner the command below. Do not do the write yourself. If a duplicate, wrong option, permission or encoding problem is reported, surface it rather than appending another line.
   ```powershell
   .\scripts\gx-camera-key.ps1 -Add -GxHost $gx -KeyPath $adminKey
   ```

Use the [camera mail guide](../../../docs/camera-ai-mail.md) for rotation, revocation and tests. The administrator key is not the camera key.
