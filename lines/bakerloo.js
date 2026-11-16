// Line data for the live map. Positions are schematic (before spacing is applied).
window.UNDERCURRENT_LINE = {
 "id": "bakerloo", "name": "Bakerloo", "api": "bakerloo",
 "colour": {"light": "#B36305", "dark": "#D48A40"},
 "train": {"light": "#6B3A06", "dark": "#F2C9A0"},
 "dirs": {
  "S": {"label": "Southbound", "platform": ["southbound"]},
  "N": {"label": "Northbound", "platform": ["northbound"]}
 },
 "spacing": 1.3,
 "stations": [
  {"id": "HAW", "naptan": "940GZZLUHAW", "code": "HAW", "name": "Harrow & Wealdstone", "x": 120, "y": 120,   "pref": "right", "lines": ["Harrow &", "Wealdstone"]},
  {"id": "KEN", "naptan": "940GZZLUKEN", "code": "KNT", "name": "Kenton",             "x": 208, "y": 208,  "pref": "right"},
  {"id": "SKT", "naptan": "940GZZLUSKT", "code": "SKT", "name": "South Kenton",       "x": 293, "y": 293,  "pref": "right"},
  {"id": "NWY", "naptan": "940GZZLUNWY", "code": "NWM", "name": "North Wembley",      "x": 372, "y": 372,  "pref": "right"},
  {"id": "WYC", "naptan": "940GZZLUWYC", "code": "WEM", "name": "Wembley Central",    "x": 455, "y": 455,  "pref": "right", "lines": ["Wembley", "Central"]},
  {"id": "SGP", "naptan": "940GZZLUSGP", "code": "SBP", "name": "Stonebridge Park",   "x": 544, "y": 544,  "pref": "right", "lines": ["Stonebridge", "Park"]},
  {"id": "HSN", "naptan": "940GZZLUHSN", "code": "HLS", "name": "Harlesden",          "x": 631, "y": 631,  "pref": "right"},
  {"id": "WJN", "naptan": "940GZZLUWJN", "code": "WJN", "name": "Willesden Junction", "x": 744, "y": 631,  "pref": "right", "lines": ["Willesden", "Junction"]},
  {"id": "KSL", "naptan": "940GZZLUKSL", "code": "KGN", "name": "Kensal Green",       "x": 864, "y": 631,  "pref": "right", "lines": ["Kensal", "Green"]},
  {"id": "QPS", "naptan": "940GZZLUQPS", "code": "QPK", "name": "Queen's Park",       "x": 986, "y": 631,  "pref": "right", "lines": ["Queen's", "Park"]},
  {"id": "KPK", "naptan": "940GZZLUKPK", "code": "KBP", "name": "Kilburn Park",       "x": 1092, "y": 631,  "pref": "right", "lines": ["Kilburn", "Park"]},
  {"id": "MVL", "naptan": "940GZZLUMVL", "code": "MVL", "name": "Maida Vale",         "x": 1170, "y": 708,  "pref": "right", "lines": ["Maida", "Vale"]},
  {"id": "WKA", "naptan": "940GZZLUWKA", "code": "WAV", "name": "Warwick Avenue",     "x": 1246, "y": 784,  "pref": "right", "lines": ["Warwick", "Avenue"]},
  {"id": "PAC", "naptan": "940GZZLUPAC", "code": "PAD", "name": "Paddington",         "x": 1325, "y": 863,  "pref": "right"},
  {"id": "ERB", "naptan": "940GZZLUERB", "code": "EGR", "name": "Edgware Road",       "x": 1429, "y": 863,  "pref": "right", "lines": ["Edgware", "Road"]},
  {"id": "MYB", "naptan": "940GZZLUMYB", "code": "MYB", "name": "Marylebone",         "x": 1531, "y": 863,  "pref": "right"},
  {"id": "BST", "naptan": "940GZZLUBST", "code": "BST", "name": "Baker Street",       "x": 1631, "y": 863,  "pref": "right", "lines": ["Baker", "Street"]},
  {"id": "RGP", "naptan": "940GZZLURGP", "code": "RPK", "name": "Regent's Park",      "x": 1739, "y": 863,  "pref": "right", "lines": ["Regent's", "Park"]},
  {"id": "OXC", "naptan": "940GZZLUOXC", "code": "OXC", "name": "Oxford Circus",      "x": 1818, "y": 942,  "pref": "right", "lines": ["Oxford", "Circus"]},
  {"id": "PCC", "naptan": "940GZZLUPCC", "code": "PIC", "name": "Piccadilly Circus",  "x": 1896, "y": 1019, "pref": "right", "lines": ["Piccadilly", "Circus"]},
  {"id": "CHX", "naptan": "940GZZLUCHX", "code": "CHX", "name": "Charing Cross",      "x": 1968, "y": 1092, "pref": "right", "lines": ["Charing", "Cross"]},
  {"id": "EMB", "naptan": "940GZZLUEMB", "code": "EMB", "name": "Embankment",         "x": 2036, "y": 1160, "pref": "right"},
  {"id": "WLO", "naptan": "940GZZLUWLO", "code": "WLO", "name": "Waterloo",           "x": 2111, "y": 1235, "pref": "right"},
  {"id": "LBN", "naptan": "940GZZLULBN", "code": "LNH", "name": "Lambeth North",      "x": 2184, "y": 1308, "pref": "right", "lines": ["Lambeth", "North"]},
  {"id": "EAC", "naptan": "940GZZLUEAC", "code": "ELE", "name": "Elephant & Castle",  "x": 2261, "y": 1385, "pref": "right", "lines": ["Elephant &", "Castle"]}
 ],
 "ix": {
  "HAW": ["lioness", "rail"], "KEN": ["lioness"], "SKT": ["lioness"], "NWY": ["lioness"], "WYC": ["lioness", "rail"],
  "SGP": ["lioness"], "HSN": ["lioness"], "WJN": ["lioness", "mildmay"], "KSL": ["lioness"], "QPS": ["lioness"],
  "PAC": ["circle", "district", "hammersmith", "elizabeth", "rail"], "MYB": ["rail"],
  "BST": ["circle", "hammersmith", "jubilee", "metropolitan"], "OXC": ["central", "victoria"], "PCC": ["piccadilly"],
  "CHX": ["northern", "rail"], "EMB": ["circle", "district", "northern"], "WLO": ["jubilee", "northern", "waterloo", "rail"],
  "EAC": ["northern", "thameslink", "rail"]
 },
 "emptyAt": [1226, 1465],
 "river": null, "riverPath": [[-2186,4227],[-1125,3166],[-724,2765],[-189,2765],[33,2986],[154,2866],[154,2560],[-54,2353],[-54,2191],[93,2044],[93,1684],[254,1523],[406,1523],[508,1624],[693,1624],[804,1513],[943,1513],[1159,1729],[1394,1729],[1651,1473],[1797,1473],[2190,1079],[2800,1079],[3136,1416],[3196,1356],[3196,1162],[4048,1162],[5548,1162]],
 "riverLabel": [1159, 1729],
 "facts": [
  {"tag": "History", "text": "The line opened on 10 March 1906 as the Baker Street and Waterloo Railway."},
  {"tag": "History", "text": "The name Bakerloo began as newspaper slang, a mash-up of Baker Street and Waterloo, and was adopted officially soon after opening."},
  {"tag": "History", "text": "The line reached Harrow & Wealdstone in 1917, running on the main-line tracks now used by the Overground's Lioness line."},
  {"tag": "History", "text": "Bakerloo trains once ran all the way to Watford Junction. The service north of Harrow & Wealdstone was withdrawn in 1982."},
  {"tag": "History", "text": "From 1939 to 1979 the Bakerloo also ran a branch to Stanmore, which became part of the new Jubilee line."},
  {"tag": "History", "text": "Charing Cross on the Bakerloo was originally called Trafalgar Square, and only took its current name in 1979."},
  {"tag": "History", "text": "Maida Vale opened in 1915 and is often said to be the first Underground station staffed entirely by women, as men left for the First World War."},
  {"tag": "Trains", "text": "The Bakerloo runs 1972 Stock trains, the oldest in passenger service on the Underground."},
  {"tag": "Design", "text": "Many original Bakerloo stations, including Lambeth North and Elephant & Castle, have Leslie Green's distinctive oxblood-red tiled buildings."},
  {"tag": "Stations", "text": "Regent's Park station has no building above ground: passengers enter by stairs from the street."},
  {"tag": "Stations", "text": "North of Queen's Park, Bakerloo trains run straight through the middle of the depot's train shed."},
  {"tag": "Depots", "text": "The line's trains are kept at Stonebridge Park, Queen's Park and London Road, near Lambeth North."},
  {"tag": "Future", "text": "A long-planned extension would take the Bakerloo south-east from Elephant & Castle towards Lewisham."}
 ]
};
