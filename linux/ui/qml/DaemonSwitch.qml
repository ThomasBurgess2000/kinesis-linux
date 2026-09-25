// A form switch that shows a setting the daemon owns. A click shows at once and asks for the
// change; the switch then follows `value`, the daemon's answer. It never binds `checked`:
// FormSwitchDelegate assigns `checked` itself when its inner switch moves, which silently drops a
// binding, and then the daemon's answer never reached the switch (it took a second click).

import QtQuick
import org.kde.kirigamiaddons.formcard as FormCard

FormCard.FormSwitchDelegate {
    id: control

    /// The setting as the daemon has it.
    property bool value: false
    /// Asked for a change; answer by updating `value`.
    signal requested(bool on)

    Component.onCompleted: checked = value
    onValueChanged: checked = value
    onToggled: {
        requested(checked);
        settle.restart();
    }

    // A refused change never moves `value`, so fall back to it after a moment.
    Timer {
        id: settle
        interval: 1500
        onTriggered: control.checked = control.value
    }
}
