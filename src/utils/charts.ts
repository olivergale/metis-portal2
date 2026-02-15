/**
 * Chart rendering utilities using HTML5 Canvas
 * Uses CSS custom properties from tokens.css for theming
 */

/**
 * Draw a line chart with axes, gridlines, and data points
 */
export function drawChart(
  canvasId: string,
  datasets: Array<{ label: string; data: number[]; color: string }>,
  opts?: { xLabels?: string[]; yLabel?: string; title?: string }
): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Handle empty datasets
  if (!datasets || datasets.length === 0 || datasets.every(d => !d.data || d.data.length === 0)) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', canvas.width / 2, canvas.height / 2);
    return;
  }

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Get colors from CSS custom properties
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();

  // Chart dimensions with padding
  const padding = { top: opts?.title ? 60 : 40, right: 40, bottom: 60, left: 60 };
  const chartWidth = canvas.width - padding.left - padding.right;
  const chartHeight = canvas.height - padding.top - padding.bottom;

  // Find min/max values across all datasets
  const allValues = datasets.flatMap(d => d.data);
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(...allValues);
  const valueRange = maxValue - minValue || 1;

  // Determine number of data points (use longest dataset)
  const maxDataPoints = Math.max(...datasets.map(d => d.data.length));

  // Draw title
  if (opts?.title) {
    ctx.fillStyle = textColor;
    ctx.font = 'bold 16px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.title, canvas.width / 2, 25);
  }

  // Draw Y-axis label
  if (opts?.yLabel) {
    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.translate(15, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }

  // Draw gridlines and Y-axis labels
  const gridLines = 5;
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = gridColor;
  ctx.font = '11px Inter, sans-serif';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.3;

  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartHeight / gridLines) * i;
    const value = maxValue - (valueRange / gridLines) * i;

    // Gridline
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();

    // Y-axis label
    ctx.globalAlpha = 1;
    ctx.textAlign = 'right';
    ctx.fillText(value.toFixed(1), padding.left - 10, y + 4);
    ctx.globalAlpha = 0.3;
  }

  ctx.globalAlpha = 1;

  // Draw axes
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.stroke();

  // Draw X-axis labels
  if (opts?.xLabels && opts.xLabels.length > 0) {
    ctx.fillStyle = gridColor;
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';

    const labelInterval = Math.max(1, Math.floor(opts.xLabels.length / 10)); // Max 10 labels
    opts.xLabels.forEach((label, index) => {
      if (index % labelInterval === 0 || index === opts.xLabels!.length - 1) {
        const x = padding.left + (chartWidth / (maxDataPoints - 1 || 1)) * index;
        ctx.fillText(label, x, padding.top + chartHeight + 20);
      }
    });
  }

  // Draw each dataset
  datasets.forEach(dataset => {
    if (!dataset.data || dataset.data.length === 0) return;

    ctx.strokeStyle = dataset.color;
    ctx.fillStyle = dataset.color;
    ctx.lineWidth = 2;

    // Draw line connecting points
    ctx.beginPath();
    dataset.data.forEach((value, index) => {
      const x = padding.left + (chartWidth / (maxDataPoints - 1 || 1)) * index;
      const y = padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // Draw data points
    dataset.data.forEach((value, index) => {
      const x = padding.left + (chartWidth / (maxDataPoints - 1 || 1)) * index;
      const y = padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight;

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // Draw legend
  if (datasets.length > 1) {
    const legendX = padding.left;
    const legendY = canvas.height - 25;
    let offsetX = 0;

    ctx.font = '11px Inter, sans-serif';
    datasets.forEach(dataset => {
      // Color box
      ctx.fillStyle = dataset.color;
      ctx.fillRect(legendX + offsetX, legendY - 8, 12, 12);

      // Label
      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      ctx.fillText(dataset.label, legendX + offsetX + 18, legendY + 2);

      offsetX += ctx.measureText(dataset.label).width + 40;
    });
  }
}

/**
 * Draw a pie/donut chart with legend and percentage labels
 */
export function drawPieChart(
  canvasId: string,
  segments: Array<{ label: string; value: number; color: string }>
): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Handle empty segments
  if (!segments || segments.length === 0 || segments.every(s => s.value <= 0)) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', canvas.width / 2, canvas.height / 2);
    return;
  }

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();

  // Calculate total value
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);
  if (total === 0) return;

  // Chart dimensions
  const centerX = canvas.width / 2;
  const centerY = canvas.height * 0.4; // Leave room for legend below
  const outerRadius = Math.min(centerX, centerY) - 20;
  const innerRadius = outerRadius * 0.4; // Donut hole

  // Draw segments
  let currentAngle = -Math.PI / 2; // Start at top

  segments.forEach(segment => {
    const sliceAngle = (segment.value / total) * Math.PI * 2;
    const percentage = (segment.value / total) * 100;

    // Draw segment
    ctx.fillStyle = segment.color;
    ctx.beginPath();
    ctx.arc(centerX, centerY, outerRadius, currentAngle, currentAngle + sliceAngle);
    ctx.arc(centerX, centerY, innerRadius, currentAngle + sliceAngle, currentAngle, true);
    ctx.closePath();
    ctx.fill();

    // Draw percentage label if segment is >5%
    if (percentage > 5) {
      const labelAngle = currentAngle + sliceAngle / 2;
      const labelRadius = innerRadius + (outerRadius - innerRadius) / 2;
      const labelX = centerX + Math.cos(labelAngle) * labelRadius;
      const labelY = centerY + Math.sin(labelAngle) * labelRadius;

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${percentage.toFixed(0)}%`, labelX, labelY);
    }

    currentAngle += sliceAngle;
  });

  // Draw legend
  const legendY = canvas.height * 0.75;
  const legendItemHeight = 20;
  const legendStartY = legendY;

  ctx.font = '12px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  segments.forEach((segment, index) => {
    const y = legendStartY + index * legendItemHeight;
    const percentage = (segment.value / total) * 100;

    // Color box
    ctx.fillStyle = segment.color;
    ctx.fillRect(20, y - 6, 12, 12);

    // Label with percentage
    ctx.fillStyle = textColor;
    ctx.fillText(`${segment.label} (${percentage.toFixed(1)}%)`, 38, y);
  });
}

/**
 * Draw a horizontal timeline showing phase progression
 */
export function drawPhaseTimeline(
  canvasId: string,
  phases: Array<{
    name: string;
    status: 'pending' | 'active' | 'done' | 'failed';
    startedAt?: string;
    completedAt?: string;
  }>
): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Handle empty phases
  if (!phases || phases.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No phases', canvas.width / 2, canvas.height / 2);
    return;
  }

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();

  // Status colors
  const statusColors = {
    pending: '#888886',
    active: '#d4a574',
    done: '#4ade80',
    failed: '#ef4444'
  };

  // Layout
  const padding = { top: 40, right: 40, bottom: 60, left: 40 };
  const timelineY = canvas.height / 2;
  const circleRadius = 12;
  const spacing = (canvas.width - padding.left - padding.right) / (phases.length - 1 || 1);

  // Draw connecting lines
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.moveTo(padding.left, timelineY);
  ctx.lineTo(canvas.width - padding.right, timelineY);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Draw phase circles and labels
  phases.forEach((phase, index) => {
    const x = padding.left + index * spacing;

    // Draw circle
    ctx.fillStyle = statusColors[phase.status];
    ctx.beginPath();
    ctx.arc(x, timelineY, circleRadius, 0, Math.PI * 2);
    ctx.fill();

    // Draw circle border for active phase
    if (phase.status === 'active') {
      ctx.strokeStyle = statusColors[phase.status];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, timelineY, circleRadius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw phase name below
    ctx.fillStyle = textColor;
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(phase.name, x, timelineY + circleRadius + 10);

    // Draw status indicator above
    ctx.fillStyle = textColor;
    ctx.font = '10px Inter, sans-serif';
    ctx.textBaseline = 'bottom';
    const statusText = phase.status.toUpperCase();
    ctx.fillText(statusText, x, timelineY - circleRadius - 10);
  });
}
