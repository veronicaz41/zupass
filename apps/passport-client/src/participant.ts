export interface ZuParticipant {
  name: string;
  email: string;
  role: string;
}

export function loadSelf(): ZuParticipant | undefined {
  const self = window.localStorage["self"];
  if (self != null && self !== "") {
    return JSON.parse(self);
  }
}

export function saveSelf(self: ZuParticipant) {
  window.localStorage["self"] = JSON.stringify(self);
}