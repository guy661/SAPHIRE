import { Box, Typography } from '@mui/material';

export default function DashboardPage() {
    return (
        <Box sx={{ maxWidth: '900px', mx: 'auto', py: { xs: 4, md: 8 }, textAlign: 'center' }}>
            <Typography variant="h4" component="h1">
                Willkommen auf Ihrem Dashboard
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 2 }}>
                Wählen Sie ein Dashboard aus dem Menü auf der linken Seite, um Ihre personalisierten Feeds anzuzeigen und zu verwalten.
            </Typography>
        </Box>
    );
}
