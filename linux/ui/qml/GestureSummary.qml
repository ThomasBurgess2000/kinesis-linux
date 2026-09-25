// "Your gestures": every assignment at a glance (Overview and the setup summary).

import QtQuick
import org.kde.kirigamiaddons.formcard as FormCard

FormCard.FormCard {
    id: summary

    readonly property var config: daemon.config
    readonly property var assigned: {
        const rows = [];
        const swipes = daemon.catalog.swipes || [];
        const taps = daemon.catalog.taps || [];
        for (const s of swipes) rows.push({ gesture: s.title, action: (config.swipes || {})[s.id] });
        for (const t of taps) rows.push({ gesture: t.title, action: (config.taps || {})[t.id] });
        return rows.filter((row) => row.action && row.action !== "none");
    }

    Repeater {
        model: summary.assigned
        delegate: FormCard.FormTextDelegate {
            required property var modelData
            text: modelData.gesture
            description: applicationWindow().actionTitle(modelData.action)
        }
    }

    FormCard.FormTextDelegate {
        readonly property var dial: summary.config.dial || ({})
        text: "Pinch + turn"
        description: !dial.target || dial.target === "none" ? "No action"
            : (dial.target === "volume" ? "Volume" : "Brightness") + " · " + (dial.sensitivity || 1) + "× sensitivity"
    }
}
