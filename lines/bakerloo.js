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
  {"id": "HAW", "naptan": "940GZZLUHAW", "code": "HAW", "name": "Harrow & Wealdstone", "x": 100, "y": 60,   "pref": "right", "lines": ["Harrow &", "Wealdstone"]},
  {"id": "KEN", "naptan": "940GZZLUKEN", "code": "KNT", "name": "Kenton",             "x": 100, "y": 140,  "pref": "right"},
  {"id": "SKT", "naptan": "940GZZLUSKT", "code": "SKT", "name": "South Kenton",       "x": 100, "y": 220,  "pref": "right"},
  {"id": "NWY", "naptan": "940GZZLUNWY", "code": "NWM", "name": "North Wembley",      "x": 100, "y": 300,  "pref": "right"},
  {"id": "WYC", "naptan": "940GZZLUWYC", "code": "WEM", "name": "Wembley Central",    "x": 100, "y": 380,  "pref": "left", "lines": ["Wembley", "Central"]},
  {"id": "SGP", "naptan": "940GZZLUSGP", "code": "SBP", "name": "Stonebridge Park",   "x": 150, "y": 430,  "pref": "right", "lines": ["Stonebridge", "Park"]},
  {"id": "HSN", "naptan": "940GZZLUHSN", "code": "HLS", "name": "Harlesden",          "x": 200, "y": 480,  "pref": "right"},
  {"id": "WJN", "naptan": "940GZZLUWJN", "code": "WJN", "name": "Willesden Junction", "x": 250, "y": 530,  "pref": "right", "lines": ["Willesden", "Junction"]},
  {"id": "KSL", "naptan": "940GZZLUKSL", "code": "KGN", "name": "Kensal Green",       "x": 300, "y": 580,  "pref": "right", "lines": ["Kensal", "Green"]},
  {"id": "QPS", "naptan": "940GZZLUQPS", "code": "QPK", "name": "Queen's Park",       "x": 350, "y": 630,  "pref": "right", "lines": ["Queen's", "Park"]},
  {"id": "KPK", "naptan": "940GZZLUKPK", "code": "KBP", "name": "Kilburn Park",       "x": 400, "y": 680,  "pref": "right", "lines": ["Kilburn", "Park"]},
  {"id": "MVL", "naptan": "940GZZLUMVL", "code": "MVL", "name": "Maida Vale",         "x": 450, "y": 730,  "pref": "right", "lines": ["Maida", "Vale"]},
  {"id": "WKA", "naptan": "940GZZLUWKA", "code": "WAV", "name": "Warwick Avenue",     "x": 500, "y": 780,  "pref": "right", "lines": ["Warwick", "Avenue"]},
  {"id": "PAC", "naptan": "940GZZLUPAC", "code": "PAD", "name": "Paddington",         "x": 550, "y": 830,  "pref": "bottom"},
  {"id": "ERB", "naptan": "940GZZLUERB", "code": "EDG", "name": "Edgware Road",       "x": 640, "y": 830,  "pref": "top", "lines": ["Edgware", "Road"]},
  {"id": "MYB", "naptan": "940GZZLUMYB", "code": "MYB", "name": "Marylebone",         "x": 730, "y": 830,  "pref": "top"},
  {"id": "BST", "naptan": "940GZZLUBST", "code": "BST", "name": "Baker Street",       "x": 820, "y": 830,  "pref": "top", "lines": ["Baker", "Street"]},
  {"id": "RGP", "naptan": "940GZZLURGP", "code": "RPK", "name": "Regent's Park",      "x": 820, "y": 910,  "pref": "right", "lines": ["Regent's", "Park"]},
  {"id": "OXC", "naptan": "940GZZLUOXC", "code": "OXC", "name": "Oxford Circus",      "x": 820, "y": 990,  "pref": "left", "lines": ["Oxford", "Circus"]},
  {"id": "PCC", "naptan": "940GZZLUPCC", "code": "PIC", "name": "Piccadilly Circus",  "x": 870, "y": 1040, "pref": "right", "lines": ["Piccadilly", "Circus"]},
  {"id": "CHX", "naptan": "940GZZLUCHX", "code": "CHX", "name": "Charing Cross",      "x": 870, "y": 1120, "pref": "right", "lines": ["Charing", "Cross"]},
  {"id": "EMB", "naptan": "940GZZLUEMB", "code": "EMB", "name": "Embankment",         "x": 870, "y": 1195, "pref": "right"},
  {"id": "WLO", "naptan": "940GZZLUWLO", "code": "WLO", "name": "Waterloo",           "x": 870, "y": 1295, "pref": "right"},
  {"id": "LBN", "naptan": "940GZZLULBN", "code": "LNH", "name": "Lambeth North",      "x": 870, "y": 1375, "pref": "right", "lines": ["Lambeth", "North"]},
  {"id": "EAC", "naptan": "940GZZLUEAC", "code": "ELE", "name": "Elephant & Castle",  "x": 920, "y": 1425, "pref": "right", "lines": ["Elephant &", "Castle"]}
 ],
 "ix": {
  "HAW": ["lioness", "rail"], "KEN": ["lioness"], "SKT": ["lioness"], "NWY": ["lioness"], "WYC": ["lioness", "rail"],
  "SGP": ["lioness"], "HSN": ["lioness"], "WJN": ["lioness", "mildmay"], "KSL": ["lioness"], "QPS": ["lioness"],
  "PAC": ["circle", "district", "hammersmith", "elizabeth", "rail"], "MYB": ["rail"],
  "BST": ["circle", "hammersmith", "jubilee", "metropolitan"], "OXC": ["central", "victoria"], "PCC": ["piccadilly"],
  "CHX": ["northern", "rail"], "EMB": ["circle", "district", "northern"], "WLO": ["jubilee", "northern", "waterloo", "rail"],
  "EAC": ["northern", "rail"]
 },
 "river": {"x": 285, "y": 787.5, "scale": 0.75, "width": 44, "label": [480, 760]},
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
