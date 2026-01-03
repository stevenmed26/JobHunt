package domain

import "time"

type JobLead struct {
	CompanyName     string
	Title           string
	URL             string
	LocationRaw     string
	WorkMode        string // remote/hybrid/onsite/unknown
	ATSJobID        string
	ReqID           string
	Description     string
	PostedAt        *time.Time
	FirstSeenSource string // email/greenhouse/etc.
}
