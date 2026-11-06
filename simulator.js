// A fake air conditioner. No GNOME code in here, just the AC's behavior,
// so it can later be swapped for something that talks to a real unit.
// All temperatures are in °F.

const MIN_TARGET = 60;
const MAX_TARGET = 86;
const AC_RATE = 0.2;       // °F moved toward target per tick when on
const DRIFT_RATE = 0.04;   // °F moved toward the room's natural temp per tick when off

// Each room has its own target. When the AC is on, a room moves toward its
// target; when off, it drifts toward its `natural` temperature.
const ROOMS = [
    {name: 'Master Bed', temp: 79, target: 70, natural: 84},
    {name: 'Bedroom 2',  temp: 80, target: 72, natural: 85},
    {name: 'Basement',   temp: 72, target: 70, natural: 74},
    {name: 'Kitchen 1',  temp: 82, target: 74, natural: 88},
];

export class ACSimulator {
    constructor() {
        this.power = false;
        this.rooms = ROOMS.map(r => ({...r}));
    }

    setPower(on) {
        this.power = on;
    }

    // Change one room's target (index into this.rooms) by delta °F.
    adjustTarget(index, delta) {
        const room = this.rooms[index];
        const t = room.target + delta;
        room.target = Math.min(MAX_TARGET, Math.max(MIN_TARGET, t));
    }

    averageTemp() {
        const sum = this.rooms.reduce((s, r) => s + r.temp, 0);
        return sum / this.rooms.length;
    }

    // Called on a timer. Moves each room's temperature one step.
    tick() {
        for (const room of this.rooms) {
            const goal = this.power ? room.target : room.natural;
            const rate = this.power ? AC_RATE : DRIFT_RATE;
            const diff = goal - room.temp;
            if (Math.abs(diff) <= rate)
                room.temp = goal;
            else
                room.temp += Math.sign(diff) * rate;
        }
    }
}
