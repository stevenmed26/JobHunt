package httpapi

type ScrapeStatus struct {
	LastRunAt string `json:"last_run_at"`
	LastOkAt  string `json:"last_ok_at"`
	LastError string `json:"last_error"`
	LastAdded int    `json:"last_added"`
	Running   bool   `json:"running"`
}
