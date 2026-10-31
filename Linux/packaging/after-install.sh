#!/bin/bash
# fpm --after-install script for the .deb target (electron-builder.linux.json's
# deb.afterInstall). Passing a custom afterInstall REPLACES electron-builder's
# own template (app-builder-lib/templates/linux/after-install.tpl) rather than
# running alongside it, so everything that template does — the /usr/bin
# symlink, chrome-sandbox's SUID bit, the mime/desktop database refresh, the
# AppArmor profile — is reproduced here first, then the one thing this task
# adds: granting CAP_SYS_PTRACE on the installed binary so Apprentice can
# attach to games without the user having to touch the Yama sysctl.
#
# ${executable} and ${sanitizedProductName} are fpm/electron-builder template
# macros (FpmTarget.js's bashTemplateOptions), substituted before this script
# is handed to fpm — by the time dpkg runs it, these are literal paths.
set -e

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# The actual point of this script: let Apprentice ptrace-attach to games
# without the user having to lower kernel.yama.ptrace_scope. Best-effort —
# a system without libcap2-bin (no setcap binary), a filesystem that
# doesn't support file capabilities (some overlay/network mounts), or a
# setcap that otherwise fails must not fail the whole package install;
# Linux/README.md documents the sysctl fallback for exactly this case, and
# ipc.ts's ptraceHelp() picks that fallback message when setcap wasn't
# applied (an AppImage never has this step at all — see its own doc there).
if hash setcap 2>/dev/null; then
  setcap cap_sys_ptrace+ep '/opt/${sanitizedProductName}/${executable}' || true
else
  echo "note: setcap not found (install libcap2-bin to let Apprentice attach to games without root); see Linux/README.md" >&2
fi

exit 0
