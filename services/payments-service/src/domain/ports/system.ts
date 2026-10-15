export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}
