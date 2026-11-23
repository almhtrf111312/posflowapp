import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getDailyProfitStats } from '@/lib/profits-store';
import { formatReportAmount, cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export type ProfitTrendDisplayMode = 'chart' | 'table';

export interface ProfitTrendChartProps {
  days?: number;
  startDate?: string;
  endDate?: string;
  displayMode?: ProfitTrendDisplayMode;
}

export function ProfitTrendChart({
  days = 30,
  startDate,
  endDate,
  displayMode = 'chart',
}: ProfitTrendChartProps) {
  const { t, isRTL, language } = useLanguage();

  const chartConfig = {
    grossProfit: {
      label: t('products.grossProfitLabel'),
      color: 'hsl(142, 76%, 36%)',
    },
    netProfit: {
      label: t('products.netProfitLabel'),
      color: 'hsl(217, 91%, 60%)',
    },
    sales: {
      label: t('products.totalSalesLabel'),
      color: 'hsl(280, 65%, 60%)',
    },
    expenses: {
      label: t('products.expensesLabel'),
      color: 'hsl(0, 84%, 60%)',
    },
  } satisfies ChartConfig;

  const chartData = useMemo(() => {
    const stats = getDailyProfitStats(days);

    let filteredStats = stats;
    if (startDate && endDate) {
      filteredStats = stats.filter(s => s.date >= startDate && s.date <= endDate);
    }

    return filteredStats
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(stat => ({
        ...stat,
        dateLabel: new Date(stat.date).toLocaleDateString(language === 'ar' ? 'ar-SA' : 'en-US', {
          month: 'short',
          day: 'numeric'
        }),
      }));
  }, [days, startDate, endDate, language]);

  const summary = useMemo(() => {
    const totalGrossProfit = chartData.reduce((sum, d) => sum + d.grossProfit, 0);
    const totalNetProfit = chartData.reduce((sum, d) => sum + d.netProfit, 0);
    const totalSales = chartData.reduce((sum, d) => sum + d.sales, 0);
    const totalExpenses = chartData.reduce((sum, d) => sum + d.expenses, 0);
    const avgDailyProfit = chartData.length > 0 ? totalNetProfit / chartData.length : 0;

    const recentDays = chartData.slice(-7);
    const previousDays = chartData.slice(-14, -7);

    const recentProfit = recentDays.reduce((sum, d) => sum + d.netProfit, 0);
    const previousProfit = previousDays.reduce((sum, d) => sum + d.netProfit, 0);

    let trend: 'up' | 'down' | 'stable' = 'stable';
    let trendPercentage = 0;

    if (previousProfit > 0) {
      trendPercentage = ((recentProfit - previousProfit) / previousProfit) * 100;
      trend = trendPercentage > 5 ? 'up' : trendPercentage < -5 ? 'down' : 'stable';
    } else if (recentProfit > 0) {
      trend = 'up';
      trendPercentage = 100;
    }

    return {
      totalGrossProfit,
      totalNetProfit,
      totalSales,
      totalExpenses,
      avgDailyProfit,
      trend,
      trendPercentage: Math.abs(trendPercentage),
      profitMargin: totalSales > 0 ? (totalNetProfit / totalSales) * 100 : 0,
    };
  }, [chartData]);

  const TrendIcon = summary.trend === 'up' ? TrendingUp : summary.trend === 'down' ? TrendingDown : Minus;
  const trendColor = summary.trend === 'up' ? 'text-success' : summary.trend === 'down' ? 'text-destructive' : 'text-muted-foreground';

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {t('products.profitTrend')}
          </CardTitle>
          <CardDescription>{t('products.noDataInPeriod')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {t('products.profitTrendDays').replace('{days}', String(chartData.length))}
          </span>
          <span className={`flex items-center gap-1 text-sm font-normal ${trendColor}`}>
            <TrendIcon className="h-4 w-4" />
            {summary.trendPercentage.toFixed(1)}%
          </span>
        </CardTitle>
        <CardDescription>
          {t('products.compareProfits')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* إخفاء البطاقات / الجدول المكرر وإبقاء المخطط البياني المباشر مع متوسط الربح اليومي */}
        {/* تم استبعاد كتلة Summary Cards المكررة بناءً على توجيهات النظام المحاسبي */}

        {/* Chart or Table based on displayMode */}
        {displayMode === 'chart' ? (
          <div className="w-full min-w-0 max-w-full overflow-hidden">
            <ChartContainer config={chartConfig} className="h-[280px] w-full min-w-0 max-w-full">
              <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={chartData}
                margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="dateLabel"
                  tickLine={false}
                  axisLine={false}
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(value) => formatReportAmount(Number(value))}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => `${t('products.dateLabel')}: ${value}`}
                      formatter={(value, name) => {
                        const labels: Record<string, string> = {
                          grossProfit: t('products.grossProfitLabel'),
                          netProfit: t('products.netProfitLabel'),
                          sales: t('products.totalSalesLabel'),
                          expenses: t('products.expensesLabel'),
                        };
                        return [formatReportAmount(Number(value)), labels[name as string] || name];
                      }}
                    />
                  }
                />
                <Legend
                  formatter={(value) => {
                    const labels: Record<string, string> = {
                      grossProfit: t('products.grossProfitLabel'),
                      netProfit: t('products.netProfitLabel'),
                    };
                    return labels[value] || value;
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="grossProfit"
                  stroke="hsl(var(--success))"
                  strokeWidth={2}
                  dot={{ fill: 'hsl(var(--success))', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6 }}
                />
                <Line
                  type="monotone"
                  dataKey="netProfit"
                  stroke="hsl(var(--info))"
                  strokeWidth={2}
                  dot={{ fill: 'hsl(var(--info))', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        ) : (
          <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-border/70 bg-card">
            <Table className="min-w-[560px] text-xs sm:text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t('products.dateLabel')}</TableHead>
                  <TableHead className="text-end">{t('products.totalSalesLabel')}</TableHead>
                  <TableHead className="text-end">{t('products.grossProfitLabel')}</TableHead>
                  <TableHead className="text-end">{t('products.expensesLabel')}</TableHead>
                  <TableHead className="text-end">{t('products.netProfitLabel')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chartData.map((row) => (
                  <TableRow key={row.date}>
                    <TableCell className="text-start font-medium text-foreground"><span dir="ltr" className="inline-block tabular-nums">{row.dateLabel || row.date}</span></TableCell>
                    <TableCell className="text-end text-foreground"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(row.sales)}</span></TableCell>
                    <TableCell className="text-end font-semibold text-success">
                      <span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(row.grossProfit)}</span>
                    </TableCell>
                    <TableCell className="text-end text-destructive">
                      <span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(row.expenses)}</span>
                    </TableCell>
                    <TableCell className={cn(
                      "text-end font-bold",
                      row.netProfit >= 0 ? "text-info" : "text-destructive"
                    )}>
                      <span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(row.netProfit)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* إحصائيات المؤشر النهائي النظيف فقط */}
        <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-xs sm:text-sm text-muted-foreground">
          <span>
            {t('products.avgDailyProfit')}: <strong className="font-bold text-primary"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(summary.avgDailyProfit)}</span></strong>
          </span>
          <span>
            {t('products.profitMargin')}: <strong className="text-foreground font-bold"><span dir="ltr" className="inline-block tabular-nums">{summary.profitMargin.toFixed(1)}%</span></strong>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
