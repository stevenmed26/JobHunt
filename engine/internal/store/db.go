package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	Pool *sql.DB
}

func Open(path string) (*DB, error) {
	// modernc sqlite uses DSN like: file:foo.db?_pragma=busy_timeout(5000)
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", path)

	pool, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	// reasonable defaults
	pool.SetMaxOpenConns(1) // sqlite typically wants 1 writer
	pool.SetConnMaxLifetime(5 * time.Minute)

	// quick ping
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return nil, err
	}

	return &DB{Pool: pool}, nil
}

func (d *DB) Close() error {
	if d == nil || d.Pool == nil {
		return nil
	}
	return d.Pool.Close()
}
