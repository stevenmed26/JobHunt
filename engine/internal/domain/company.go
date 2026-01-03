package domain

type Company struct {
	ID        int64
	Name      string
	CareerURL string
	ATSType   string
	PollLane  string // fast/normal
	Active    bool
}
