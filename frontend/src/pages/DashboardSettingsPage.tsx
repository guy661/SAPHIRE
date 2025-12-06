import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
    Box, Typography, Button, Paper, FormControl, FormLabel, RadioGroup, 
    FormControlLabel, Radio, Slider, Switch, CircularProgress, Alert 
} from '@mui/material';
import { getDashboardById, updateDashboardSettings } from '../services/api';

export default function DashboardSettingsPage() {
    const { dashboardId } = useParams<{ dashboardId: string }>();
    const navigate = useNavigate();
    
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Settings State
    const [summaryStyle, setSummaryStyle] = useState('detailed');
    const [hasInterval, setHasInterval] = useState(false);
    const [intervalHours, setIntervalHours] = useState(4); // Default 4h

    useEffect(() => {
        if (!dashboardId) return;
        setLoading(true);
        getDashboardById(dashboardId)
            .then(dashboard => {
                setSummaryStyle(dashboard.summary_style || 'detailed');
                if (dashboard.interval_minutes && dashboard.interval_minutes > 0) {
                    setHasInterval(true);
                    setIntervalHours(dashboard.interval_minutes / 60);
                } else {
                    setHasInterval(false);
                }
            })
            .catch(err => {
                console.error('Failed to load dashboard:', err);
                setError('Dashboard konnte nicht geladen werden.');
            })
            .finally(() => setLoading(false));
    }, [dashboardId]);

    const handleSave = async () => {
        if (!dashboardId) return;
        setSaving(true);
        setError(null);

        const intervalMinutes = hasInterval ? intervalHours * 60 : 0;
        const isActive = hasInterval; // If interval is set, we assume it's active

        try {
            await updateDashboardSettings(dashboardId, {
                summary_style: summaryStyle,
                interval_minutes: intervalMinutes,
                is_active: isActive
            });
            // Navigate to Dashboard Detail on success
            navigate(`/dashboard/${dashboardId}`);
        } catch (err) {
            console.error('Failed to save settings:', err);
            setError('Einstellungen konnten nicht gespeichert werden.');
            setSaving(false);
        }
    };

    if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>;

    return (
        <Box sx={{ maxWidth: '600px', mx: 'auto', p: 3 }}>
            <Typography variant="h4" gutterBottom>Einstellungen für Ihre Zusammenfassung</Typography>
            <Typography variant="body1" color="text.secondary" paragraph>
                Passen Sie an, wie und wann Sie informiert werden möchten.
            </Typography>

            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

            <Paper sx={{ p: 3, mb: 3 }}>
                <FormControl component="fieldset" fullWidth sx={{ mb: 4 }}>
                    <FormLabel component="legend" sx={{ mb: 1, fontWeight: 'bold' }}>Länge & Detailgrad</FormLabel>
                    <RadioGroup
                        value={summaryStyle}
                        onChange={(e) => setSummaryStyle(e.target.value)}
                    >
                        <FormControlLabel value="brief" control={<Radio />} label="Kurz & Bündig (Nur Headlines & wichtigste Fakten)" />
                        <FormControlLabel value="balanced" control={<Radio />} label="Ausgewogen (Standard)" />
                        <FormControlLabel value="detailed" control={<Radio />} label="Detailliert (Hintergründe, Analysen & Details)" />
                    </RadioGroup>
                </FormControl>

                <FormControl component="fieldset" fullWidth>
                    <FormLabel component="legend" sx={{ mb: 1, fontWeight: 'bold' }}>Automatisches Update (Intervall)</FormLabel>
                    <FormControlLabel
                        control={
                            <Switch 
                                checked={hasInterval} 
                                onChange={(e) => setHasInterval(e.target.checked)} 
                            />
                        }
                        label={hasInterval ? "Aktiviert" : "Deaktiviert (Manuelle Suche)"}
                        sx={{ mb: 2 }}
                    />

                    {hasInterval && (
                        <Box sx={{ px: 2 }}>
                            <Typography gutterBottom>
                                Aktualisierung alle <strong>{intervalHours} Stunden</strong>
                            </Typography>
                            <Slider
                                value={intervalHours}
                                onChange={(_, newValue) => setIntervalHours(newValue as number)}
                                step={1}
                                marks={[
                                    { value: 1, label: '1h' },
                                    { value: 4, label: '4h' },
                                    { value: 12, label: '12h' },
                                    { value: 24, label: '24h' },
                                ]}
                                min={1}
                                max={24}
                                valueLabelDisplay="auto"
                            />
                        </Box>
                    )}
                </FormControl>
            </Paper>

            <Button 
                variant="contained" 
                fullWidth 
                size="large" 
                onClick={handleSave} 
                disabled={saving}
            >
                {saving ? <CircularProgress size={24} color="inherit" /> : 'Speichern & Fertigstellen'}
            </Button>
        </Box>
    );
}
