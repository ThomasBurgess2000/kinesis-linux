// A form combo box that always shows `selectedId` (from the daemon's config). A ComboBox resets its
// selection whenever its model changes, and the action catalog arrives after the window is built,
// so a plain `currentIndex` binding ends up on the first item ("No action"). The selection is
// re-applied after every change instead.

import QtQuick
import org.kde.kirigamiaddons.formcard as FormCard

FormCard.FormComboBoxDelegate {
    id: delegate

    /// [{ id, title }]
    property var options: []
    property string selectedId: ""
    signal chosen(string id)

    function sync() {
        for (let i = 0; i < options.length; i++) {
            if (options[i].id === selectedId) {
                currentIndex = i;
                return;
            }
        }
        currentIndex = options.length > 0 ? 0 : -1;
    }

    model: options
    textRole: "title"
    valueRole: "id"

    onSelectedIdChanged: sync()
    onOptionsChanged: Qt.callLater(sync) // after the model (bound to options) has reset itself
    Component.onCompleted: sync()
    onActivated: if (currentValue !== selectedId) chosen(currentValue)
}
