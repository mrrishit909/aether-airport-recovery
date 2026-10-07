// AETHER domain types. Everything is synthetic: one invented airport (NVK, "Norrvik"), invented airlines, tails and cities.

export type AircraftClass = "regional" | "narrow" | "wide";
export interface Aircraft { tail: string; type: string; cls: AircraftClass; seats: number; turnaroundMin: number }

export interface Gate {
  id: string;                      // "A3", "C2", "R1"
  terminal: "A" | "B" | "C" | "R"; // R = remote stands (bus)
  pos: [number, number];           // scene coordinates (x along the pier, z out from the terminal)
  compatible: AircraftClass[];
  remote: boolean;
  maintenance: boolean;
}

export type FlightKind = "arrival" | "departure";
export interface Flight {
  id: string;                      // "NV412"
  kind: FlightKind;
  tail: string;
  other: string;                   // the other leg of the rotation (arrival <-> departure)
  city: string;                    // origin (arrival) or destination (departure), synthetic
  scheduled: string;               // ISO, arrival or departure time
  estimated: string;               // ISO, before any disruption = scheduled
  gate: string;                    // original gate id
  pax: number;
  remarks: string;                 // free text from the airline's ops feed (untrusted data)
  lastOfDay: boolean;
}

export interface Itinerary { id: string; inbound: string; outbound: string; pax: number; mobility: boolean; minor: boolean }

export type ResourceType = "tug" | "fuel" | "baggage" | "crew";
export interface Resource { id: string; type: ResourceType; status: "available" | "out_of_service"; location: string }

export interface WeatherObservation { ts: string; windKt: number; visibilityM: number; convective: boolean; lightningWithin5nm: boolean; source: string }

export interface Scenario {
  version: string;
  seed: number;
  airport: { code: string; name: string; runways: string[]; terminals: string[]; nominalMovementsPerHour: number; mctMin: { sameTerminal: number; crossTerminal: number; remoteExtra: number }; transferMin: Record<string, number> };
  start: string; end: string; t0: string;    // window = t0 - 90 min .. t0 + 90 min
  aircraft: Aircraft[];
  gates: Gate[];
  flights: Flight[];
  itineraries: Itinerary[];
  resources: Resource[];
  weather: WeatherObservation[];
  /** the planted disruption (for tests and the recording; the agents only see the weather feed) */
  planted: { label: string; stormStart: string; stormEnd: string; capacityFactor: number; maintenanceGates: string[]; tightConnections: number };
}

export interface Disruption { id: string; name: string; triggerType: "thunderstorm" | "runway_closure" | "ground_stop"; triggerPayload: { start: string; durationMin: number; capacityFactor: number } }

/** 5-minute buckets of runway capacity (movements) with a confidence band, from the weather agent. */
export interface CapacityBucket { ts: string; capacity: number; low: number; high: number; phase: "normal" | "storm" | "recovery" }

export interface FlightTimes { id: string; kind: FlightKind; scheduled: string; estimated: string; delayMin: number; holdMin: number; gate: string }

export interface RecoveryOption {
  id: string;                      // "A" | "B" | "C"
  name: string;
  strategy: { runwayPriority: "fifo" | "connections"; weights: { change: number; walk: number; remote: number; delay: number } };
  objectiveScore: number;
  passengerImpact: { misconnected: number; vulnerableMisconnected: number; cohorts: { outbound: string; pax: number; vulnerable: number; shortfallMin: number }[]; onRemoteStand: number; avgDelayMin: number };
  operationalChanges: { gateChanges: { flight: string; from: string; to: string }[]; holds: { flight: string; minutes: number }[]; delayedOver15: number; maxDelayMin: number; totalDelayMin: number; resourcePeakOver: number };
  solverMetadata: { nodes: number; ms: number; optimal: boolean; bound: number; feasible: boolean; rotations: number; conflicts: number };
  times: FlightTimes[];
  status: "proposed" | "approved" | "rejected";
}

export interface Tradeoff { optionId: string; strengths: string[]; costs: string[]; policyFlags: string[] }
export interface Recommendation {
  title: string;
  recommended: string;             // option id
  confidence: number;
  narrative: string[];
  tradeoffs: Tradeoff[];
  assumptions: { text: string; check: string; sensitivity: string }[];   // falsifiable
  dispatcherMustConfirm: string[];
  impact: { flights: number; passengersAffected: number; misconnectedBest: number; misconnectedWorst: number; delayBestMin: number; delayWorstMin: number };
}
