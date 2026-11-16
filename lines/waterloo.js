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
  {"id": "BNK", "naptan": "940GZZLUBNK", "code": "BNK", "name": "Bank",     "x": 224, "y": 120, "pref": "right"},
  {"id": "WLO", "naptan": "940GZZLUWLO", "code": "WLO", "name": "Waterloo", "x": 120, "y": 224, "pref": "right"}
 ],
 "routes": [["BNK", "WLO"]],
 "run": [240],
 "emptyAt": [172, 304],
 "ix": {
  "BNK": ["central", "northern", "dlr"],
  "WLO": ["bakerloo", "jubilee", "northern", "rail"]
 },
 "river": null, "riverPath": [[-2498,2196],[-1438,1135],[-1253,950],[-1006,950],[-903,1052],[-848,996],[-848,856],[-943,760],[-943,685],[-876,617],[-876,451],[-801,377],[-731,377],[-684,424],[-599,424],[-547,372],[-483,372],[-384,472],[-275,472],[-157,354],[-89,354],[92,172],[373,172],[529,327],[556,300],[556,210],[949,210],[1041,118],[1288,118],[1477,308],[1665,308],[1828,471],[2889,1532]],
 "riverLabel": [373, 172],
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
