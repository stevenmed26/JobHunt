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
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinURL: string;
  portfolioURL: string;
  githubURL: string;
  location: string;
  workAuth: WorkAuth;
  requiresSponsorship: boolean;
  yearsExperience: string;
  currentTitle: string;
  desiredSalary: string;
  gender: Gender;
  race: Race;
  veteranStatus: VeteranStatus;
  disabilityStatus: DisabilityStatus;
  resumeText: string;
  coverLetterText: string;
  resumeFileName: string;
  coverLetterFileName: string;
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