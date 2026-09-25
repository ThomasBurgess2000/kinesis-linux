// Sixteen points in a circle, one for each electrode on the band. At rest they are barely there.
// While you hold a pinch and turn, the ones your wrist points at light up. Port of upstream's
// ElectrodeRing.

import QtQuick
import org.kde.kirigami as Kirigami

Canvas {
    id: ring

    /// Degrees of turn, zero at the top.
    property real angle: 0
    /// 0 to 1: how far the dial is engaged.
    property real engaged: 0

    Behavior on engaged { NumberAnimation { duration: 300; easing.type: Easing.OutQuad } }
    Behavior on angle { NumberAnimation { duration: 80; easing.type: Easing.OutQuad } }

    onAngleChanged: requestPaint()
    onEngagedChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()

    onPaint: {
        const ctx = getContext("2d");
        ctx.reset();
        const radius = Math.min(width, height) / 2 - 10;
        for (let electrode = 0; electrode < 16; electrode++) {
            let degrees = electrode * 22.5;
            if (degrees > 180) degrees -= 360;
            let apart = Math.abs((degrees - angle) % 360);
            if (apart > 180) apart = 360 - apart;
            const lit = engaged * Math.max(0, 1 - apart / 36);
            const turn = (degrees - 90) * Math.PI / 180;
            const size = 3 + 3 * lit;
            const x = width / 2 + radius * Math.cos(turn);
            const y = height / 2 + radius * Math.sin(turn);
            ctx.beginPath();
            ctx.ellipse(x - size / 2, y - size / 2, size, size);
            ctx.globalAlpha = 0.24;
            ctx.fillStyle = Kirigami.Theme.textColor;
            ctx.fill();
            if (lit > 0.01) {
                ctx.globalAlpha = lit;
                ctx.fillStyle = Kirigami.Theme.highlightColor;
                ctx.fill();
            }
        }
    }
}
