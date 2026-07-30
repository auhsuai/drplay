use rodio::{Source, source::SeekError};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub struct FadeableSource<I> {
    inner: I,
    current_vol: f32,
    target_vol: Arc<AtomicU32>,
    step: f32,
}

impl<I> FadeableSource<I>
where
    I: Source<Item = f32>,
{
    pub fn new(inner: I, target_vol_arc: Arc<AtomicU32>) -> Self {
        let start_vol = f32::from_bits(target_vol_arc.load(Ordering::Relaxed));
        let sample_rate = inner.sample_rate();
        // Calculate step to complete a full 0.0 to 1.0 fade in ~30ms
        // If sample_rate is 44100, 30ms is 1323 samples.
        // Step = 1.0 / 1323 = 0.00075.
        // For stereo (channels = 2), next() is called twice per frame, so we divide by channels.
        let channels = inner.channels() as f32;
        let frames_in_30ms = (sample_rate as f32) * 0.030;
        let step = 1.0 / (frames_in_30ms * channels.max(1.0));

        Self {
            inner,
            current_vol: start_vol,
            target_vol: target_vol_arc,
            step,
        }
    }
}

impl<I> Iterator for FadeableSource<I>
where
    I: Source<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.inner.next()?;
        let target = f32::from_bits(self.target_vol.load(Ordering::Relaxed));

        if (self.current_vol - target).abs() > self.step {
            if self.current_vol < target {
                self.current_vol += self.step;
            } else {
                self.current_vol -= self.step;
            }
        } else {
            self.current_vol = target;
        }

        Some(sample * self.current_vol)
    }
}

impl<I> Source for FadeableSource<I>
where
    I: Source<Item = f32>,
{
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.inner.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    #[inline]
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)
    }
}
