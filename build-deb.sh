#!/usr/bin/env bash
# ponytail: Native .deb packager for Heist Bridge
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTO_INSTALL=false

for arg in "$@"; do
    case "$arg" in
        -i|--install)
            AUTO_INSTALL=true
            ;;
        -h|--help)
            echo "Usage: ./build-deb.sh [--install|-i]"
            echo "  --install, -i   Automatically install .deb package after build"
            exit 0
            ;;
    esac
done

VERSION=$(grep -m1 'version' "${ROOT_DIR}/bridge/Cargo.toml" | cut -d '"' -f 2)
PKG_NAME="heist-bridge"
ARCH="amd64"
DEB_NAME="${PKG_NAME}_${VERSION}_${ARCH}.deb"
DIST_DIR="${ROOT_DIR}/dist"
STAGE_DIR="${DIST_DIR}/stage_${PKG_NAME}"

echo "==> [1/4] Compiling Rust release binary (${PKG_NAME} v${VERSION})..."
cargo build --release --manifest-path "${ROOT_DIR}/bridge/Cargo.toml"

echo "==> [2/4] Preparing Debian package layout..."
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/DEBIAN"
mkdir -p "${STAGE_DIR}/usr/bin"
mkdir -p "${STAGE_DIR}/usr/share/applications"
mkdir -p "${STAGE_DIR}/usr/share/icons/hicolor/512x512/apps"
mkdir -p "${STAGE_DIR}/usr/share/icons/hicolor/128x128/apps"
mkdir -p "${STAGE_DIR}/usr/share/icons/hicolor/32x32/apps"

# 1. Copy binary
cp "${ROOT_DIR}/bridge/target/release/heist-bridge" "${STAGE_DIR}/usr/bin/heist-bridge"
chmod +x "${STAGE_DIR}/usr/bin/heist-bridge"

# 2. Copy App Icons
if [ -f "${ROOT_DIR}/bridge/icons/icon.png" ]; then
    cp "${ROOT_DIR}/bridge/icons/icon.png" "${STAGE_DIR}/usr/share/icons/hicolor/512x512/apps/heist-bridge.png"
fi
if [ -f "${ROOT_DIR}/bridge/icons/128x128.png" ]; then
    cp "${ROOT_DIR}/bridge/icons/128x128.png" "${STAGE_DIR}/usr/share/icons/hicolor/128x128/apps/heist-bridge.png"
fi
if [ -f "${ROOT_DIR}/bridge/icons/32x32.png" ]; then
    cp "${ROOT_DIR}/bridge/icons/32x32.png" "${STAGE_DIR}/usr/share/icons/hicolor/32x32/apps/heist-bridge.png"
fi

# 3. Create Desktop Entry Shortcut
cat <<EOF > "${STAGE_DIR}/usr/share/applications/heist-bridge.desktop"
[Desktop Entry]
Name=Heist Bridge
Comment=Centralized Android Test Automation Fleet System Tray Bridge
Exec=/usr/bin/heist-bridge
Icon=heist-bridge
Terminal=false
Type=Application
Categories=Development;Utility;
Keywords=Android;ADB;ATM;Automation;Test;Heist;
StartupNotify=true
EOF
chmod 644 "${STAGE_DIR}/usr/share/applications/heist-bridge.desktop"

# 4. Create DEBIAN Control File
cat <<EOF > "${STAGE_DIR}/DEBIAN/control"
Package: ${PKG_NAME}
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Endri Susanto <endri@endrisusanto.my.id>
Section: utils
Priority: optional
Depends: libc6, libgtk-3-0, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37, libayatana-appindicator3-1, adb | android-tools-adb
Description: Heist Bridge Daemon
 Native system tray fleet bridge daemon connecting local ADB Android devices to heist.endrisusanto.my.id Web Hub.
EOF

# 5. Create postinst hook for icon cache update
cat <<'EOF' > "${STAGE_DIR}/DEBIAN/postinst"
#!/bin/sh
set -e
if which update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q || true
fi
if which gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
exit 0
EOF
chmod 755 "${STAGE_DIR}/DEBIAN/postinst"

echo "==> [3/4] Building .deb package using dpkg-deb..."
mkdir -p "${DIST_DIR}"
dpkg-deb --build --root-owner-group "${STAGE_DIR}" "${DIST_DIR}/${DEB_NAME}"
rm -rf "${STAGE_DIR}"

echo "==> [4/4] Package built successfully!"
echo "--------------------------------------------------------"
echo "Package File: ${DIST_DIR}/${DEB_NAME}"
echo "File Size:    $(du -h "${DIST_DIR}/${DEB_NAME}" | cut -f1)"
echo "--------------------------------------------------------"

if [ "$AUTO_INSTALL" = true ]; then
    echo "==> [Auto-Install] Installing ${DEB_NAME}..."
    if [ "${EUID:-$(id -u)}" -eq 0 ]; then
        dpkg -i "${DIST_DIR}/${DEB_NAME}"
    else
        sudo dpkg -i "${DIST_DIR}/${DEB_NAME}"
    fi
    echo "==> [✔] Package ${PKG_NAME} successfully installed and ready!"
else
    echo "Untuk menginstall di node Linux, jalankan:"
    echo "  sudo dpkg -i ${DIST_DIR}/${DEB_NAME}"
    echo "Atau jalankan build dengan opsi auto-install:"
    echo "  ./build-deb.sh --install"
    echo "--------------------------------------------------------"
fi
