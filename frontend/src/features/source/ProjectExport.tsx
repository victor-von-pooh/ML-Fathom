import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOutput } from 'lucide-react'

import { ApiError, useApi } from '../../api/client'
import type { Recipe } from '../../api/types'
import { Button, ErrorBox, Spinner } from '../../components/ui'
import { anomalyOf, demandOf, priceOf, upliftOf } from '../../lib/recipe'
import { AnomalyRows } from './AnomalyRows'
import { DemandRows } from './DemandRows'
import { ModelHintsView } from './ModelHintsView'
import { PriceRows } from './PriceRows'
import { UpliftRows } from './UpliftRows'

/**
 * 問題の設定から始めたデータを, 問題の設定に記録したプロジェクトの書き出し先
 * (学習のスクリプトがデータセットを読む場所) へ書き出す.
 * 前に書き出したデータセットは確かめてから置き換え, データセットでないものは
 * 置き換えない
 */
export function ProjectExport({
  sourceId,
  recipe,
  onExported,
  reasons,
}: {
  sourceId: string
  recipe: Recipe
  onExported: () => void
  /** 書き出せない理由を並べた要素の id (理由があれば押せない) */
  reasons?: string
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const place = useQuery({
    queryKey: ['project', sourceId],
    queryFn: () => api.project(sourceId),
    retry: false,
  })
  const exporter = useMutation({
    mutationFn: (body: { recipe: Recipe; overwrite: boolean }) =>
      api.exportProject(sourceId, body.recipe, body.overwrite),
    onSuccess: (_, body) => {
      // 書き出しはレシピも保存するので, 読み直しを待たずに保存したものにする
      queryClient.setQueryData(['recipe', sourceId], body.recipe)
      void queryClient.invalidateQueries({ queryKey: ['datasets'] })
      void queryClient.invalidateQueries({ queryKey: ['recipe', sourceId] })
      void queryClient.invalidateQueries({ queryKey: ['project', sourceId] })
      onExported()
    },
    // 他で書き出し先が変わった (409) ら様子を読み直す
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['project', sourceId] })
      }
    },
  })
  const data = place.data
  // 書き出した後にレシピを変えたら, 前の結果と誤りは出さない
  const same = JSON.stringify(exporter.variables?.recipe) === JSON.stringify(recipe)
  const done = exporter.data && same ? exporter.data : null
  // 異常の検知のデータセットの説明の anomaly (他のタスクは null)
  const doneAnomaly = done ? anomalyOf(done.info) : null
  // 効果を見積もるのデータセットの説明の uplift (他のタスクは null)
  const doneUplift = done ? upliftOf(done.info) : null
  // 値段を変える判断のデータセットの説明の price (他のタスクは null)
  const donePrice = done ? priceOf(done.info) : null
  // 時間をまたぐ量の判断のデータセットの説明の demand (他のタスクは null)
  const doneDemand = done ? demandOf(done.info) : null
  const failed = exporter.error && same ? exporter.error : null
  if (place.isPending) return <Spinner label="プロジェクトの書き出し先を調べています" />
  // 問題の設定を読めない理由は問題の設定のカードに出るので, ここは短く
  if (place.error) return <ErrorBox error={place.error} />
  if (!data) return null

  // 前に書き出したデータセットがあれば, 置き換えてよいかを確かめる
  const run = () => {
    const replace = data.state === 'dataset'
    if (
      replace &&
      !window.confirm(`${data.dataset} には前に書き出したデータセットがあります. 置き換えますか?`)
    ) {
      return
    }
    exporter.mutate({ recipe, overwrite: replace })
  }
  return (
    <section
      aria-labelledby={`project-export-${sourceId}`}
      className="mt-4 border-t border-line pt-3"
    >
      <h3 id={`project-export-${sourceId}`} className="text-xs font-semibold text-ink-2">
        プロジェクトへ書き出す
      </h3>
      {data.dataset ? (
        <>
          <p className="mt-1 text-xs text-ink-3">
            問題の設定に記録した学習のプロジェクトの, データセットを読む場所に書き出します.
          </p>
          <p className="mt-1 truncate font-mono text-xs" title={data.dataset}>
            {data.dataset}
          </p>
          {data.state === 'dataset' && (
            <p className="text-xs text-ink-3">
              前に書き出したものがあります (書き出すと, 確かめてから置き換えます)
            </p>
          )}
        </>
      ) : null}
      {data.reason && <p className="mt-1 text-xs text-warning-text">{data.reason}</p>}
      {data.ready && (
        <Button
          variant="primary"
          icon={FolderOutput}
          className="mt-2"
          // 書き出し先の様子を読み直す間は押せない (古い様子で置き換えを決めないように)
          disabled={exporter.isPending || place.isFetching || reasons !== undefined}
          aria-describedby={reasons}
          onClick={run}
        >
          {exporter.isPending ? '書き出し中…' : 'プロジェクトへ書き出す'}
        </Button>
      )}
      {failed && <ErrorBox error={failed} />}
      {done && (
        <div className="mt-3 space-y-2 text-sm">
          <p role="status" className="text-good-text">
            プロジェクトへ書き出しました: {done.path}
          </p>
          {doneAnomaly && <AnomalyRows summary={doneAnomaly} />}
          {doneUplift && <UpliftRows summary={doneUplift} />}
          {donePrice && <PriceRows summary={donePrice} />}
          {doneDemand && <DemandRows summary={doneDemand} />}
          {done.hints && (
            <ModelHintsView
              hints={done.hints}
              anomaly={doneAnomaly !== null}
              uplift={doneUplift !== null}
              price={donePrice !== null}
              demand={doneDemand !== null}
            />
          )}
        </div>
      )}
    </section>
  )
}
