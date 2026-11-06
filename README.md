# AC Control

A GNOME Shell extension that adds an air conditioner dropdown to the top bar,
next to the wifi/bluetooth/power icons. The AC is simulated for now.

## Files

- `metadata.json` – name, ID (`ac-control@liam-clark`), supported GNOME versions
- `extension.js` – the top-bar icon and dropdown menu
- `simulator.js` – the fake AC: 4 rooms, each with its own target (°F); rooms move toward their target when on, toward a natural temp when off
- `stylesheet.css` – styling for the dropdown

## Install / run

The folder is symlinked into `~/.local/share/gnome-shell/extensions/`, so edits
here are picked up directly.

    # first time only: log out and back in, then
    gnome-extensions enable ac-control@liam-clark

After editing code: log out and back in (Wayland can't restart GNOME Shell in place).

## Debugging

    journalctl -f -o cat /usr/bin/gnome-shell    # live errors from the shell
    gnome-extensions info ac-control@liam-clark  # status / errors
