// The Thames: one master shape shared by every line map. Each line only moves and resizes it
// (see "river" in the line file), so the river looks the same whichever line is shown.
// Coordinates match the Victoria line map. West to east: Hammersmith loop, Battersea, Vauxhall,
// the bend at Westminster, the City, the Isle of Dogs loop, the Greenwich peninsula, then east.
// v3.52: long straight tails at both ends (the shape between x -1500 and 2600 is unchanged), so the river runs past both edges of every map at any zoom.
window.UNDERCURRENT_RIVER = {
  d: "M -9500 900 L -1500 900 L -1000 900 L -1000 1210 L -800 1210 L -600 1010 L 150 1010 L 400 760 L 560 760 L 710 610 L 1500 610 L 1500 880 L 1660 880 L 1660 520 L 1820 520 L 1820 700 L 2600 700 L 10100 700",
  width: 46
};
