// src/types.ts — shared types for the Auto Apply feature

import type { ScrapedField } from "./api";

export type WorkAuth = "us_citizen" | "green_card" | "h1b" | "other";
export type Gender = "male" | "female" | "non_binary" | "prefer_not";
export type Race =
  | "white"
  | "black"
  | "hispanic"
  | "asian"
  | "native"
  | "pacific"
  | "two_or_more"
  | "prefer_not";
export type VeteranStatus = "yes" | "no" | "prefer_not";
export type DisabilityStatus = "yes" | "no" | "prefer_not";

export interface ApplicantProfile {
  // Identity
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinURL: string;
  portfolioURL: string;
  githubURL: string;

  // Location — stored split so Groq can answer country/state/city questions precisely
  location: string;   // display string e.g. "Dallas, TX"
  city: string;
  state: string;
  country: string;    // full country name e.g. "United States"

  // Work
  workAuth: WorkAuth;
  requiresSponsorship: boolean;
  authorizedToWork: boolean;   // authorized to work in current country (non-US)
  yearsExperience: string;
  currentTitle: string;
  desiredSalary: string;
  noticePeriod: string;        // e.g. "2 weeks", "Immediately", "1 month"

  // Common custom questions
  previouslyEmployed: boolean;       // previously worked at / consulted for this company
  employmentRestrictions: string;    // any employment agreements or post-employment restrictions

  // EEO
  gender: Gender;
  race: Race;
  veteranStatus: VeteranStatus;
  disabilityStatus: DisabilityStatus;

  // Docs
  resumeText: string;
  coverLetterText: string;
  resumeFileName: string;
  coverLetterFileName: string;
  coverLetterSaveDir: string; // directory where generated cover letters are saved
  saveCoverLetterEnabled?: boolean; // whether to save generated cover letters to disk
}

export interface ApplicationDraft {
  jobId: number;
  company: string;
  title: string;
  url: string;
  atsType: "greenhouse" | "lever" | "unknown";
  atsSlug: string;
  atsJobId: string;
  // Status flow: pending → scraping → scraped → filling → ready → submitted
  status: "pending" | "scraping" | "scraped" | "filling" | "ready" | "submitted" | "error";
  fields: ApplicationField[];
  scrapedFields: ScrapedField[];
  errorMsg?: string;
  applying?: boolean;
}

export interface ApplicationField {
  key: string;
  label: string;
  value: string;
  source: "profile" | "ai" | "manual";
  required: boolean;
}