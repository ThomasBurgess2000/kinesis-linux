// Eight EMG traces over the last second of sensor time, auto-scaled in ADC counts. Batches arrive
// from the daemon's "emg" events; a gap in sequence or time starts a new line segment.

import QtQuick
import org.kde.kirigami as Kirigami

Canvas {
    id: trace

    property bool active: false
    property var batches: []
    readonly property bool empty: batches.length === 0
    property int low: 32736
    property int high: 32800

    readonly property real sampleUs: 1000000 / 2048
    readonly property real batchUs: 16 * sampleUs

    Connections {
        target: daemon
        function onEmg(data) {
            let kept = data.restart ? [] : trace.batches.slice();
            for (const batch of data.batches) kept.push(batch);
            const newest = kept.length ? kept[kept.length - 1].timestampUs : 0;
            kept = kept.filter((b) => newest - b.timestampUs <= 1000000);
            trace.batches = kept;
            trace.requestPaint();
        }
    }

    onActiveChanged: requestPaint()
    onWidthChanged: requestPaint()

    onPaint: {
        const ctx = getContext("2d");
        ctx.reset();
        const labelWidth = 30;
        const plotWidth = width - labelWidth;
        const rowHeight = height / 8;
        // Auto scale across every channel, with a little headroom.
        let min = 65535, max = 0;
        for (const b of batches) for (const v of b.values) { if (v < min) min = v; if (v > max) max = v; }
        if (!batches.length) { min = 32736; max = 32800; }
        const padding = Math.max(16, (max - min) * 0.08);
        const lo = Math.max(0, min - padding), hi = Math.min(65535, max + padding);
        trace.low = Math.round(lo);
        trace.high = Math.round(hi);
        const end = batches.length ? batches[batches.length - 1].timestampUs + batchUs : 0;
        const start = end - 1000000;
        const text = Kirigami.Theme.textColor;
        const accent = Kirigami.Theme.highlightColor;

        ctx.font = Kirigami.Theme.smallFont.pixelSize + "px monospace";
        ctx.textBaseline = "middle";
        for (let channel = 0; channel < 8; channel++) {
            const top = channel * rowHeight;
            const mid = top + rowHeight / 2;
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = text;
            ctx.fillText(String(channel + 1).padStart(2, "0"), 0, mid);
            ctx.globalAlpha = 0.15;
            ctx.strokeStyle = text;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(labelWidth, mid);
            ctx.lineTo(width, mid);
            ctx.stroke();

            ctx.globalAlpha = active ? 0.95 : 0.35;
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            let previous = null;
            let lastX = -Infinity;
            let open = false;
            for (const b of batches) {
                const continuous = previous !== null
                    && Number(b.sequence) - Number(previous.sequence) === 1
                    && Math.abs(b.timestampUs - previous.timestampUs - batchUs) <= 2;
                for (let s = 0; s < 16; s++) {
                    const t = b.timestampUs + s * sampleUs;
                    if (t < start) continue;
                    const x = labelWidth + (t - start) / 1000000 * plotWidth;
                    const y = top + 3 + (1 - (b.values[s * 8 + channel] - lo) / (hi - lo)) * (rowHeight - 6);
                    if (!open || (s === 0 && !continuous)) {
                        ctx.moveTo(x, y);
                        open = true;
                        lastX = x;
                    } else if (x - lastX >= 0.75) {
                        // About one point per pixel column: 2048 samples a second won't all show anyway.
                        ctx.lineTo(x, y);
                        lastX = x;
                    }
                }
                previous = b;
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
}
