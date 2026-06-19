package manager

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/remeh/sizedwaitgroup"
	"github.com/stashapp/stash/internal/desktop"
	"github.com/stashapp/stash/internal/dlna"
	"github.com/stashapp/stash/internal/log"
	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/ffmpeg"
	"github.com/stashapp/stash/pkg/fsutil"
	"github.com/stashapp/stash/pkg/gallery"
	"github.com/stashapp/stash/pkg/group"
	"github.com/stashapp/stash/pkg/image"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models/paths"
	"github.com/stashapp/stash/pkg/plugin"
	"github.com/stashapp/stash/pkg/scene"
	"github.com/stashapp/stash/pkg/scraper"
	"github.com/stashapp/stash/pkg/session"
	"github.com/stashapp/stash/pkg/sqlite"
	"github.com/stashapp/stash/pkg/utils"
	"github.com/stashapp/stash/ui"
)

// Called at startup
func Initialize(cfg *config.Config, l *log.Logger) (*Manager, error) {
	ctx := context.TODO()

	db := sqlite.NewDatabase()
	repo := db.Repository()

	// start with empty paths
	mgrPaths := &paths.Paths{}

	scraperRepository := scraper.NewRepository(repo)
	scraperCache := scraper.NewCache(cfg, scraperRepository)

	pluginCache := plugin.NewCache(cfg)

	sceneService := &scene.Service{
		File:             db.File,
		Repository:       db.Scene,
		MarkerRepository: db.SceneMarker,
		PluginCache:      pluginCache,
		Paths:            mgrPaths,
		Config:           cfg,
	}

	imageService := &image.Service{
		File:       db.File,
		Repository: db.Image,
	}

	galleryService := &gallery.Service{
		Repository:   db.Gallery,
		ImageFinder:  db.Image,
		ImageService: imageService,
		File:         db.File,
		Folder:       db.Folder,
	}

	groupService := &group.Service{
		Repository: db.Group,
	}

	sceneServer := &SceneServer{
		TxnManager:       repo.TxnManager,
		SceneCoverGetter: repo.Scene,
	}

	dlnaRepository := dlna.NewRepository(repo)
	dlnaService := dlna.NewService(dlnaRepository, cfg, sceneServer)

	mgr := &Manager{
		Config: cfg,
		Logger: l,

		Paths: mgrPaths,

		ImageThumbnailGenerateWaitGroup: sizedwaitgroup.New(1),

		JobManager:      initJobManager(cfg),
		ReadLockManager: fsutil.NewReadLockManager(),

		DownloadStore: NewDownloadStore(),

		PluginCache:  pluginCache,
		ScraperCache: scraperCache,

		DLNAService: dlnaService,

		Database:   db,
		Repository: repo,

		SceneService:   sceneService,
		ImageService:   imageService,
		GalleryService: galleryService,
		GroupService:   groupService,

		scanSubs: &subscriptionManager{},
	}

	if !cfg.IsNewSystem() {
		logger.Infof("using config file: %s", cfg.GetConfigFile())

		err := cfg.Validate()
		if err != nil {
			return nil, fmt.Errorf("invalid configuration: %w", err)
		}

		if err := mgr.postInit(ctx); err != nil {
			return nil, err
		}

		mgr.checkSecurityTripwire()
	} else {
		cfgFile := cfg.GetConfigFile()
		if cfgFile != "" {
			cfgFile += " "
		}

		// create temporary session store - this will be re-initialised
		// after config is complete
		mgr.SessionStore = session.NewStore(cfg)

		logger.Warnf("config file %snot found. Assuming new system...", cfgFile)
	}

	instance = mgr
	return mgr, nil
}

func formatDuration(t time.Duration) string {
	switch {
	case t >= time.Minute: // 1m23s or 2h45m12s
		t = t.Round(time.Second)
	case t >= time.Second: // 45.36s
		t = t.Round(10 * time.Millisecond)
	default: // 51ms
		t = t.Round(time.Millisecond)
	}

	return t.String()
}

func initJobManager(cfg *config.Config) *job.Manager {
	ret := job.NewManager()

	// desktop notifications
	ctx := context.Background()
	c := ret.Subscribe(context.Background())
	go func() {
		for {
			select {
			case j := <-c.RemovedJob:
				if cfg.GetNotificationsEnabled() {
					cleanDesc := strings.TrimRight(j.Description, ".")

					if j.StartTime == nil {
						// Task was never started
						return
					}

					timeElapsed := j.EndTime.Sub(*j.StartTime)
					msg := fmt.Sprintf("Task \"%s\" finished in %s.", cleanDesc, formatDuration(timeElapsed))
					desktop.SendNotification("Task Finished", msg)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// stashhub in-app job watchdog: cancels any RUNNING job whose
	// progress has not advanced for jobStallTimeout. Replaces the
	// external cron-based watchdog so Stash is self-healing without
	// any system-level glue. Tick every minute; track progress per job
	// ID in a small in-memory map.
	go runJobStallWatchdog(ctx, ret)

	return ret
}

const (
	jobWatchdogTick    = 1 * time.Minute
	jobStallTimeout    = 15 * time.Minute
	jobStallProgressEps = 1e-6
	// Generate-side ffmpegs sometimes chew on a single huge file for
	// hours, so the parent job's progress moves forward just enough
	// to dodge the stall timer. Treat any ffmpeg writing into
	// generated/tmp older than this as a runaway and kill it; the
	// generate task will move on to the next file.
	ffmpegMaxAge = 25 * time.Minute
)

type stallSeen struct {
	progress float64
	at       time.Time
}

func runJobStallWatchdog(ctx context.Context, mgr *job.Manager) {
	seen := make(map[int]stallSeen)
	t := time.NewTicker(jobWatchdogTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		queue := mgr.GetQueue()
		now := time.Now()
		alive := make(map[int]bool, len(queue))
		for _, j := range queue {
			alive[j.ID] = true
			if j.Status != job.StatusRunning {
				delete(seen, j.ID)
				continue
			}
			prev, ok := seen[j.ID]
			if !ok || math.Abs(j.Progress-prev.progress) > jobStallProgressEps {
				seen[j.ID] = stallSeen{progress: j.Progress, at: now}
				continue
			}
			if now.Sub(prev.at) >= jobStallTimeout {
				logger.Warnf("[job-watchdog] cancelling stalled job id=%d \"%s\" stuck at progress=%.4f for %s",
					j.ID, j.Description, j.Progress, now.Sub(prev.at).Round(time.Second))
				mgr.CancelJob(j.ID)
				delete(seen, j.ID)
			}
		}
		for id := range seen {
			if !alive[id] {
				delete(seen, id)
			}
		}
		killRunawayFfmpegs()
	}
}

// killRunawayFfmpegs scans /proc for ffmpeg processes writing into the
// generated/tmp directory and SIGKILLs any that have been running longer
// than ffmpegMaxAge. Stash retries the file on the next pass, so the
// only cost is having to redo whatever that single ffmpeg was producing.
// Pure /proc reads, no shell out.
func killRunawayFfmpegs() {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	bootSec := readBtime()
	hz := uint64(100)
	now := time.Now()
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 1 {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil || len(cmdline) == 0 {
			continue
		}
		// /proc/PID/cmdline is NUL-separated. Look for "ffmpeg" as
		// the binary and "generated/tmp" anywhere in args.
		args := string(cmdline)
		if !strings.Contains(args, "ffmpeg") || !strings.Contains(args, "generated/tmp") {
			continue
		}
		statBytes, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue
		}
		// stat field 22 is starttime in clock ticks since boot. The first
		// two fields (pid, comm) can contain spaces/parens; parse defensively.
		stat := string(statBytes)
		rparen := strings.LastIndex(stat, ")")
		if rparen < 0 || rparen+2 >= len(stat) {
			continue
		}
		fields := strings.Fields(stat[rparen+1:])
		// Index 21 within `fields` (because we trimmed off the first 2 stat fields).
		if len(fields) < 20 {
			continue
		}
		startTicks, err := strconv.ParseUint(fields[19], 10, 64)
		if err != nil {
			continue
		}
		startSec := bootSec + int64(startTicks/hz)
		age := now.Sub(time.Unix(startSec, 0))
		if age < ffmpegMaxAge {
			continue
		}
		logger.Warnf("[job-watchdog] killing runaway ffmpeg pid=%d age=%s",
			pid, age.Round(time.Second))
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Kill()
		}
	}
}

// readBtime returns the system boot epoch from /proc/stat once per call.
// Cheap enough not to cache.
func readBtime() int64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			n, _ := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime ")), 10, 64)
			return n
		}
	}
	return 0
}

// postInit initialises the paths, caches and database after the initial
// configuration has been set. Should only be called if the configuration
// is valid.
func (s *Manager) postInit(ctx context.Context) error {
	s.RefreshConfig()

	s.SessionStore = session.NewStore(s.Config)
	s.PluginCache.RegisterSessionStore(s.SessionStore)

	s.RefreshPluginCache()
	s.RefreshPluginSourceManager()

	s.RefreshScraperCache()
	s.RefreshScraperSourceManager()

	s.RefreshDLNA()

	s.SetBlobStoreOptions()

	s.writeStashIcon()

	// clear the downloads and tmp directories
	// #1021 - only clear these directories if the generated folder is non-empty
	if s.Config.GetGeneratedPath() != "" {
		const deleteTimeout = 1 * time.Second

		utils.Timeout(func() {
			if err := fsutil.EmptyDir(s.Paths.Generated.Downloads); err != nil {
				logger.Warnf("could not empty downloads directory: %v", err)
			}
			if err := fsutil.EnsureDir(s.Paths.Generated.Tmp); err != nil {
				logger.Warnf("could not create temporary directory: %v", err)
			} else {
				if err := fsutil.EmptyDir(s.Paths.Generated.Tmp); err != nil {
					logger.Warnf("could not empty temporary directory: %v", err)
				}
			}
		}, deleteTimeout, func(done chan struct{}) {
			logger.Info("Please wait. Deleting temporary files...") // print
			<-done                                                  // and wait for deletion
			logger.Info("Temporary files deleted.")
		})
	}

	if err := s.Database.Open(s.Config.GetDatabasePath()); err != nil {
		var migrationNeededErr *sqlite.MigrationNeededError
		if errors.As(err, &migrationNeededErr) {
			logger.Warn(err)
		} else {
			return err
		}
	}

	// Set the proxy if defined in config
	if s.Config.GetProxy() != "" {
		os.Setenv("HTTP_PROXY", s.Config.GetProxy())
		os.Setenv("HTTPS_PROXY", s.Config.GetProxy())
		os.Setenv("NO_PROXY", s.Config.GetNoProxy())
		logger.Info("Using HTTP proxy")
	}

	s.RefreshFFMpeg(ctx)
	s.RefreshStreamManager()

	return nil
}

func (s *Manager) checkSecurityTripwire() {
	if err := session.CheckExternalAccessTripwire(s.Config); err != nil {
		session.LogExternalAccessError(*err)
	}
}

func (s *Manager) writeStashIcon() {
	iconPath := filepath.Join(s.Config.GetConfigPath(), "icon.png")
	err := os.WriteFile(iconPath, ui.FaviconProvider.GetFaviconPng(), 0644)
	if err != nil {
		logger.Errorf("Couldn't write icon file: %v", err)
	}
}

func (s *Manager) RefreshFFMpeg(ctx context.Context) {
	// use same directory as config path
	// executing binaries requires directory to be included
	// https://pkg.go.dev/os/exec#hdr-Executables_in_the_current_directory
	configDirectory := s.Config.GetConfigPathAbs()
	stashHomeDir := paths.GetStashHomeDirectory()

	// prefer the configured paths
	ffmpegPath := s.Config.GetFFMpegPath()
	ffprobePath := s.Config.GetFFProbePath()

	// ensure the paths are valid
	if ffmpegPath != "" {
		// path was set explicitly
		if err := ffmpeg.ValidateFFMpeg(ffmpegPath); err != nil {
			logger.Errorf("invalid ffmpeg path: %v", err)
			return
		}

		if err := ffmpeg.ValidateFFMpegCodecSupport(ffmpegPath); err != nil {
			logger.Warn(err)
		}
	} else {
		ffmpegPath = ffmpeg.ResolveFFMpeg(configDirectory, stashHomeDir)
	}

	if ffprobePath != "" {
		if err := ffmpeg.ValidateFFProbe(ffmpegPath); err != nil {
			logger.Errorf("invalid ffprobe path: %v", err)
			return
		}
	} else {
		ffprobePath = ffmpeg.ResolveFFProbe(configDirectory, stashHomeDir)
	}

	if ffmpegPath == "" {
		logger.Warn("Couldn't find FFmpeg")
	}
	if ffprobePath == "" {
		logger.Warn("Couldn't find FFProbe")
	}

	if ffmpegPath != "" && ffprobePath != "" {
		logger.Debugf("using ffmpeg: %s", ffmpegPath)
		logger.Debugf("using ffprobe: %s", ffprobePath)

		s.FFMpeg = ffmpeg.NewEncoder(ffmpegPath)
		s.FFProbe = ffmpeg.NewFFProbe(ffprobePath)

		s.FFMpeg.InitHWSupport(ctx)
	}
}
