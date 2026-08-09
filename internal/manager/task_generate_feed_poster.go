package manager

import (
	"bytes"
	"context"
	"fmt"
	"image/jpeg"
	"os"
	"path/filepath"
	"strconv"

	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/scene/generate"
)

// GenerateFeedPosterTask writes the scene's first frame next to its fast-mode
// copy. The normal cover is taken 20% into the video, so using it as the feed
// poster makes the picture jump the moment playback starts.
type GenerateFeedPosterTask struct {
	repository models.Repository
	Scene      models.Scene
	Overwrite  bool
	generator  *generate.Generator
}

// Seconds to try, in order. Zero matches the opening frame exactly; the rest
// walk forward for clips that fade in or open on a long dark intro. A poster
// is still written if every one is dark, since the scene itself is dark and
// there is nothing better to show.
var feedPosterOffsets = []float64{0, 1, 2, 4, 8, 15, 30}

func (t *GenerateFeedPosterTask) GetDescription() string {
	return fmt.Sprintf("Generating feed poster for %s", t.Scene.GetTitle())
}

// isMostlyBlack reports whether a still is too dark to be worth showing.
// Sampled on a grid rather than every pixel, which is plenty to tell a fade-in
// frame from a real picture and costs almost nothing.
func isMostlyBlack(data []byte) bool {
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return false
	}

	b := img.Bounds()
	if b.Empty() {
		return false
	}

	const steps = 24
	stepX := b.Dx() / steps
	stepY := b.Dy() / steps
	if stepX < 1 {
		stepX = 1
	}
	if stepY < 1 {
		stepY = 1
	}

	var total, n uint64
	for y := b.Min.Y; y < b.Max.Y; y += stepY {
		for x := b.Min.X; x < b.Max.X; x += stepX {
			r, g, bl, _ := img.At(x, y).RGBA()
			// Rec. 601 luma, on the 0-65535 range RGBA() returns.
			total += uint64((299*r + 587*g + 114*bl) / 1000)
			n++
		}
	}

	if n == 0 {
		return false
	}

	// Roughly 6% of full white. Catches black and near-black title cards
	// without rejecting a legitimately dim opening shot.
	return total/n < 4000
}

// posterPath is the still for a scene, or "" when no generated path is set.
func (t *GenerateFeedPosterTask) posterPath() string {
	dir := fastModeDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, strconv.Itoa(t.Scene.ID)+".jpg")
}

func (t *GenerateFeedPosterTask) required() bool {
	if t.Scene.Path == "" {
		return false
	}

	dst := t.posterPath()
	if dst == "" {
		return false
	}

	if t.Overwrite {
		return true
	}

	info, err := os.Stat(dst)
	return err != nil || info.Size() == 0
}

func (t *GenerateFeedPosterTask) Start(ctx context.Context) {
	if !t.required() {
		return
	}

	dst := t.posterPath()

	r := t.repository
	if err := r.WithReadTxn(ctx, func(ctx context.Context) error {
		return t.Scene.LoadPrimaryFile(ctx, r.File)
	}); err != nil {
		logger.Error(err)
		return
	}

	videoFile := t.Scene.Files.Primary()
	if videoFile == nil {
		return
	}

	// Start at frame zero so the poster matches what playback opens on. Many
	// clips fade in from black though, and a black poster leaves every tile
	// that has not loaded yet looking empty, so step forward until there is
	// an actual picture.
	var data []byte
	var err error
	for _, at := range feedPosterOffsets {
		if at > 0 && at >= videoFile.Duration {
			break
		}

		offset := at
		data, err = t.generator.Screenshot(ctx, videoFile.Path, videoFile.Width, videoFile.Duration, generate.ScreenshotOptions{
			At: &offset,
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Errorf("Error generating feed poster for scene %d: %v", t.Scene.ID, err)
			return
		}

		if !isMostlyBlack(data) {
			break
		}
	}

	if len(data) == 0 {
		return
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		logger.Errorf("Error creating feed poster directory: %v", err)
		return
	}

	// Written to a temp name and renamed on success, so an interrupted run
	// never leaves a half-written file that looks finished.
	part := dst + ".part"
	if err := os.WriteFile(part, data, 0644); err != nil {
		logger.Errorf("Error writing feed poster for scene %d: %v", t.Scene.ID, err)
		return
	}

	if err := os.Rename(part, dst); err != nil {
		_ = os.Remove(part)
		logger.Errorf("Error saving feed poster for scene %d: %v", t.Scene.ID, err)
	}
}
