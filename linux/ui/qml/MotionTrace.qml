// Three gyro traces over the last three seconds, from the daemon's "motion" updates. A gap in the
// stream breaks the line instead of bridging it. Port of upstream's MotionReadingsView graph.

import QtQuick
import org.kde.kirigami as Kirigami

Canvas {
    id: trace

    /// [host seconds, x, y, z] in degrees per second.
    property var samples: []
    readonly property bool empty: samples.length === 0
    readonly property real window: 3
    property int range: 60

    Connections {
        target: daemon
        function onMotion(data) {
            let kept = data.restart ? [] : trace.samples.slice();
            for (const sample of data.gyro) kept.push(sample);
            const newest = kept.length ? kept[kept.length - 1][0] : 0;
            kept = kept.filter((s) => newest - s[0] <= trace.window);
            trace.samples = kept;
            trace.requestPaint();
        }
    }

    onWidthChanged: requestPaint()

    onPaint: {
        const ctx = getContext("2d");
        ctx.reset();
        let peak = 0;
        for (const s of samples) peak = Math.max(peak, Math.abs(s[1]), Math.abs(s[2]), Math.abs(s[3]));
        const range = Math.max(60, peak) * 1.1;
        trace.range = Math.round(range);
        const end = samples.length ? samples[samples.length - 1][0] : 0;
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = Kirigami.Theme.textColor;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        const colors = [Kirigami.Theme.highlightColor, Kirigami.Theme.textColor, Kirigami.Theme.disabledTextColor];
        for (let axis = 0; axis < 3; axis++) {
            ctx.globalAlpha = axis === 0 ? 1 : 0.7;
            ctx.strokeStyle = colors[axis];
            ctx.lineWidth = 1;
            ctx.beginPath();
            let previous = null;
            for (const s of samples) {
                const x = (1 - (end - s[0]) / window) * width;
                const y = height / 2 * (1 - s[axis + 1] / range);
                if (previous === null || s[0] - previous > 0.1) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                previous = s[0];
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
}
