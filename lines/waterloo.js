// Line data for the live map. Positions are schematic (before spacing is applied).
window.UNDERCURRENT_LINE = {
 "id": "waterloo", "name": "Waterloo & City", "api": "waterloo-city",
 "colour": {"light": "#95CDBA", "dark": "#A9DCCB"},
 "train": {"light": "#3F7F6A", "dark": "#E2F4EC"},
 "dirs": {
  "S": {"label": "Westbound", "stat": "To Waterloo", "platform": ["westbound", "southbound"]},
  "N": {"label": "Eastbound", "stat": "To Bank", "platform": ["eastbound", "northbound"]}
 },
 "spacing": 1.3,
 "stations": [
  {"id": "BNK", "naptan": "940GZZLUBNK", "code": "BNK", "name": "Bank",     "x": 660, "y": 540, "pref": "right"},
  {"id": "WLO", "naptan": "940GZZLUWLO", "code": "WLO", "name": "Waterloo", "x": 300, "y": 900, "pref": "left"}
 ],
 "routes": [["BNK", "WLO"]],
 "run": [240],
 "emptyAt": [860, 1080],
 "ix": {
  "BNK": ["central", "northern", "dlr"],
  "WLO": ["bakerloo", "jubilee", "northern", "rail"]
 },
 "river": {"x": -500, "y": 110, "scale": 1, "width": 44, "label": [1100, 610]},
 "facts": [
  {"tag": "History", "text": "The Waterloo & City line opened in 1898 and was built by the London and South Western Railway to carry commuters from Waterloo to the City."},
  {"tag": "History", "text": "It has long been nicknamed 'the Drain'."},
  {"tag": "History", "text": "The line was run by the main line railway companies until it passed to London Underground in 1994."},
  {"tag": "Engineering", "text": "The line is about 1.5 miles (2.4 km) long and runs entirely in tunnel, passing under the Thames between its two stations."},
  {"tag": "Engineering", "text": "It is not connected to any other railway, so trains needing heavy maintenance are lifted out by crane at Waterloo."},
  {"tag": "Trains", "text": "The journey between Waterloo and Bank takes about four minutes."},
  {"tag": "Trains", "text": "The line uses 1992 Stock trains."},
  {"tag": "Stations", "text": "Waterloo is one of Britain's busiest railway stations, and most of the line's passengers arrive here on main line trains."},
  {"tag": "Stations", "text": "At Bank, the line's platforms link to the Central and Northern lines and the Docklands Light Railway."}
 ]
};
