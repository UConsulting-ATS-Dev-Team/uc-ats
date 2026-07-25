import React, { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Stack,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Chip
} from '@mui/material';
import { useTheme, ThemeProvider, alpha } from '@mui/material/styles';
import { BarChart as BarChartIcon, DonutLarge as DonutLargeIcon } from '@mui/icons-material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  LabelList
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import globalTheme from '../styles/globalTheme';

function DemographicChartCard({ title, icon: Icon, data, type, emptyText, xAxisAngle = 0, limit }) {
  const theme = useTheme();
  const total = data.reduce((sum, item) => sum + item.value, 0);

  const hasOther = typeof limit === 'number' && limit > 0 && data.length > limit;
  const otherValue = hasOther
    ? data.slice(limit - 1).reduce((sum, item) => sum + item.value, 0)
    : 0;
  const displayData = hasOther
    ? [...data.slice(0, limit - 1), { name: 'Other', value: otherValue }]
    : data;

  const chartColors = [
    theme.palette.primary.main,
    theme.palette.secondary.main,
    theme.palette.success.main,
    theme.palette.info.main,
    theme.palette.warning.main,
    theme.palette.error.main,
    theme.palette.primary.light,
    theme.palette.secondary.light,
  ];

  const getColor = (item, index) =>
    item.name === 'Other' ? theme.palette.grey[500] : chartColors[index % chartColors.length];

  const chartBody = displayData.length > 0 ? (
    <>
      <Box sx={{ height: 280, width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          {type === 'bar' ? (
            <BarChart data={displayData} margin={{ top: 20, right: 20, left: 0, bottom: xAxisAngle ? 70 : 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={alpha(theme.palette.divider, 0.5)} />
              <XAxis
                dataKey="name"
                angle={xAxisAngle}
                textAnchor={xAxisAngle ? 'end' : 'middle'}
                height={xAxisAngle ? 70 : 30}
                fontSize={12}
                tick={{ fill: theme.palette.text.secondary }}
                interval={0}
              />
              <YAxis allowDecimals={false} tick={{ fill: theme.palette.text.secondary }} />
              <Tooltip
                formatter={(value) => [`${value} application${value !== 1 ? 's' : ''}`, 'Count']}
                contentStyle={{ borderRadius: theme.shape.borderRadius, border: 'none', boxShadow: theme.shadows[4] }}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                <LabelList dataKey="value" position="top" fill={theme.palette.text.primary} fontSize={12} />
                {displayData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={getColor(entry, index)} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <PieChart>
              <Pie
                data={displayData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="45%"
                outerRadius={80}
                innerRadius={45}
                stroke={theme.palette.background.paper}
                strokeWidth={2}
                labelLine={false}
                label={({ percent }) => `${(percent * 100).toFixed(0)}%`}
              >
                {displayData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={getColor(entry, index)} />
                ))}
              </Pie>
              <Tooltip formatter={(value, name) => [`${value}`, `${name}`]} />
              <Legend verticalAlign="bottom" height={36} />
            </PieChart>
          )}
        </ResponsiveContainer>
      </Box>
      <Stack direction="row" flexWrap="wrap" gap={1} mt={2} justifyContent="center">
        {displayData.map((item, index) => {
          const color = getColor(item, index);
          const pct = total > 0 ? ((item.value / total) * 100).toFixed(0) : 0;
          return (
            <Chip
              key={item.name}
              size="small"
              label={`${item.name}: ${item.value} (${pct}%)`}
              sx={{
                bgcolor: alpha(color, 0.1),
                color: 'text.primary',
                border: `1px solid ${alpha(color, 0.4)}`,
                fontWeight: 500,
                maxWidth: '100%',
              }}
            />
          );
        })}
      </Stack>
    </>
  ) : (
    <Box
      sx={{
        height: 280,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
        textAlign: 'center',
      }}
    >
      <Icon color="disabled" sx={{ fontSize: 40, mb: 1 }} />
      <Typography color="text.secondary" variant="body1" gutterBottom>
        {emptyText}
      </Typography>
      <Typography color="text.disabled" variant="body2">
        No data to display
      </Typography>
    </Box>
  );

  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        boxShadow: 1,
      }}
    >
      <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 2 }}>
          <Box sx={{ color: 'primary.main', display: 'flex' }}>
            <Icon />
          </Box>
          <Typography variant="h6" sx={{ fontWeight: 600, color: 'text.primary' }}>
            {title}
          </Typography>
        </Stack>
        {chartBody}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ totalApplicants: 0, tasks: 0, candidates: 0, currentRound: 'SUBMITTED' });
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [demographicData, setDemographicData] = useState({
    majors: [],
    genders: [],
    gpaRanges: [],
    graduationYears: [],
    transferStudents: [],
    firstGeneration: []
  });
  const [demographicsLoading, setDemographicsLoading] = useState(false);
  const [demographicsError, setDemographicsError] = useState('');
  const [applicationCount, setApplicationCount] = useState(0);

  const load = async () => {
    try {
      setLoading(true);
      const [s, c] = await Promise.allSettled([
        apiClient.get('/admin/stats'),
        apiClient.get('/admin/cycles/active'),
      ]);
      
      // Handle stats result
      if (s.status === 'fulfilled') {
        setStats(s.value);
      } else {
        console.error('Failed to load stats:', s.reason);
        setStats({ totalApplicants: 0, tasks: 0, candidates: 0, currentRound: 'SUBMITTED' });
      }
      
      // Handle active cycle result
      if (c.status === 'fulfilled') {
        setActiveCycle(c.value);
      } else {
        console.error('Failed to load active cycle:', c.reason);
        setActiveCycle(null);
      }
    } catch (e) {
      console.error('Error in load function:', e);
      setError(e.message || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const fetchDemographicData = async () => {
    try {
      setDemographicsLoading(true);
      setDemographicsError('');
      const applications = await apiClient.get('/admin/applications');
      
      // Handle case where applications might be null or undefined
      if (!applications || !Array.isArray(applications)) {
        console.warn('No applications data received or invalid format');
        setApplicationCount(0);
        setDemographicData({
          majors: [],
          genders: [],
          gpaRanges: [],
          graduationYears: [],
          transferStudents: [],
          firstGeneration: []
        });
        return;
      }
      
      setApplicationCount(applications.length);

      // Process demographic data
      const majors = {};
      const genders = {};
      const gpaRanges = { '3.5-4.0': 0, '3.0-3.4': 0, '2.5-2.9': 0, '2.0-2.4': 0, 'Below 2.0': 0 };
      const graduationYears = {};
      const transferStudents = { 'Transfer': 0, 'Non-Transfer': 0 };
      const firstGeneration = { 'First Generation': 0, 'Not First Generation': 0 };

      applications.forEach(app => {
        // Majors - API returns 'major' not 'major1'
        const majorValue = app.major || app.major1;
        if (majorValue && majorValue.trim() !== '') {
          const major = majorValue.trim();
          majors[major] = (majors[major] || 0) + 1;
        }

        // Genders - skip if empty/null
        if (app.gender && app.gender.trim() !== '') {
          const gender = app.gender.trim();
          genders[gender] = (genders[gender] || 0) + 1;
        }

        // GPA Ranges - API returns 'gpa' not 'cumulativeGpa'
        const gpaValue = app.gpa || app.cumulativeGpa;
        const gpa = parseFloat(gpaValue);
        if (!isNaN(gpa) && gpa > 0) {
          if (gpa >= 3.5) gpaRanges['3.5-4.0']++;
          else if (gpa >= 3.0) gpaRanges['3.0-3.4']++;
          else if (gpa >= 2.5) gpaRanges['2.5-2.9']++;
          else if (gpa >= 2.0) gpaRanges['2.0-2.4']++;
          else gpaRanges['Below 2.0']++;
        }

        // Graduation Years - API returns 'year' not 'graduationYear'
        const yearValue = app.year || app.graduationYear;
        if (yearValue && String(yearValue).trim() !== '') {
          const year = String(yearValue).trim();
          graduationYears[year] = (graduationYears[year] || 0) + 1;
        }

        // Transfer Students
        if (app.isTransferStudent === true) {
          transferStudents['Transfer']++;
        } else if (app.isTransferStudent === false) {
          transferStudents['Non-Transfer']++;
        }

        // First Generation
        if (app.isFirstGeneration === true) {
          firstGeneration['First Generation']++;
        } else if (app.isFirstGeneration === false) {
          firstGeneration['Not First Generation']++;
        }
      });

      // Filter out zero-value entries for cleaner charts
      const filterZeroValues = (data) => data.filter(item => item.value > 0);

      setDemographicData({
        majors: Object.entries(majors).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
        genders: filterZeroValues(Object.entries(genders).map(([name, value]) => ({ name, value }))),
        gpaRanges: filterZeroValues(Object.entries(gpaRanges).map(([name, value]) => ({ name, value }))),
        graduationYears: Object.entries(graduationYears).map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)),
        transferStudents: filterZeroValues(Object.entries(transferStudents).map(([name, value]) => ({ name, value }))),
        firstGeneration: filterZeroValues(Object.entries(firstGeneration).map(([name, value]) => ({ name, value })))
      });
    } catch (err) {
      console.error('Error fetching demographic data:', err);
      setDemographicsError('Failed to load demographic data. Please try refreshing.');
      setApplicationCount(0);
      setDemographicData({
        majors: [],
        genders: [],
        gpaRanges: [],
        graduationYears: [],
        transferStudents: [],
        firstGeneration: []
      });
    } finally {
      setDemographicsLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      Promise.all([load(), fetchDemographicData()]);
    }
  }, [user]);

  // Listen for cycle activation events
  useEffect(() => {
    if (!user) return;

    const handleCycleActivated = async () => {
      // Reload dashboard data when a new cycle is activated
      await Promise.all([load(), fetchDemographicData()]);
    };

    window.addEventListener('cycleActivated', handleCycleActivated);

    return () => {
      window.removeEventListener('cycleActivated', handleCycleActivated);
    };
  }, [user]);

  if (!user) {
    return (
      <ThemeProvider theme={globalTheme}>
        <Box>
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h4" gutterBottom>
              Authentication Required
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Please log in to view the dashboard.
            </Typography>
          </Paper>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={globalTheme}>
      <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
        <Box sx={{ maxWidth: 1200, mx: 'auto', p: 0 }}>
          {/* Header */}
          <Box sx={{ mb: 4 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
              <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
                Admin Dashboard
              </Typography>
              <Button
                variant="outlined"
                onClick={() => {
                  load();
                  fetchDemographicData();
                }}
                disabled={loading || demographicsLoading}
              >
                Refresh
              </Button>
            </Stack>
          </Box>

          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
          {demographicsError && (
            <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setDemographicsError('')}>
              {demographicsError}
            </Alert>
          )}

          {/* Stats Cards */}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} mb={4}>
            <Paper sx={{ p: 2, flex: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">Active Cycle</Typography>
              {activeCycle ? (
                <>
                  <Typography variant="h6">{activeCycle.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {activeCycle.startDate ? new Date(activeCycle.startDate).toLocaleDateString() : '—'}
                    {' '}to{' '}
                    {activeCycle.endDate ? new Date(activeCycle.endDate).toLocaleDateString() : '—'}
                  </Typography>
                </>
              ) : (
                <Typography variant="body1">No active cycle</Typography>
              )}
            </Paper>

            <Paper sx={{ p: 2, flex: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">Total Candidates (cycle)</Typography>
              <Typography variant="h4">{stats.totalApplicants}</Typography>
            </Paper>

            <Paper sx={{ p: 2, flex: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">In Pipeline</Typography>
              <Typography variant="h4">{stats.candidates}</Typography>
            </Paper>

            <Paper sx={{ p: 2, flex: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">Current Stage</Typography>
              <Typography variant="h6">{stats.currentRound?.replace('_', ' ') || '—'}</Typography>
            </Paper>
          </Stack>

          {/* Demographics Section */}
          <Box sx={{ mb: 4 }}>
            <Stack direction="row" alignItems="center" gap={1.5} mb={1}>
              <Box sx={{ width: 4, height: 28, bgcolor: 'primary.main', borderRadius: 1 }} />
              <Typography variant="h5" component="h2" sx={{ fontWeight: 700, color: 'primary.main' }}>
                Application Demographics
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {applicationCount > 0 ? `${applicationCount} applications analyzed` : 'No applications to analyze'}
            </Typography>
          </Box>

          {demographicsLoading ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', p: 4 }}>
              <CircularProgress size={40} sx={{ mb: 2 }} />
              <Typography color="text.secondary">Loading demographics...</Typography>
            </Box>
          ) : (
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, md: 6 }}>
                <DemographicChartCard
                  title="Applications by Major"
                  icon={BarChartIcon}
                  data={demographicData.majors}
                  type="bar"
                  emptyText="No major data available"
                  xAxisAngle={-45}
                  limit={8}
                />
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <DemographicChartCard
                  title="GPA Distribution"
                  icon={DonutLargeIcon}
                  data={demographicData.gpaRanges}
                  type="pie"
                  emptyText="No GPA data available"
                />
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <DemographicChartCard
                  title="Gender Distribution"
                  icon={DonutLargeIcon}
                  data={demographicData.genders}
                  type="pie"
                  emptyText="No gender data available"
                />
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <DemographicChartCard
                  title="Graduation Years"
                  icon={BarChartIcon}
                  data={demographicData.graduationYears}
                  type="bar"
                  emptyText="No graduation year data available"
                />
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <DemographicChartCard
                  title="Transfer Students"
                  icon={DonutLargeIcon}
                  data={demographicData.transferStudents}
                  type="pie"
                  emptyText="No transfer student data available"
                />
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <DemographicChartCard
                  title="First Generation Students"
                  icon={DonutLargeIcon}
                  data={demographicData.firstGeneration}
                  type="pie"
                  emptyText="No first generation data available"
                />
              </Grid>
            </Grid>
          )}
        </Box>
      </AccessControl>
    </ThemeProvider>
  );
}
