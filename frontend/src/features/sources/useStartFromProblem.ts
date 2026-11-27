import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'

import { useApi } from '../../api/client'
import type { ProblemList, ProblemStarted, Source } from '../../api/types'
import { problemIdOf, useStage } from '../../lib/stage'

/**
 * 問題の設定から始める (「問題の設定から始める」の対話と, 殻で選んだ問題の設定の欄で同じ流れ)
 *
 * データを登録したら onAdded に渡し, ファイルの組の受け持ちは onLeave を呼んでから
 * 書き出しの画面へ問題の設定を付けて移る. 置き場の問題の設定から始めたら, 殻に識別子を知らせる
 */
export function useStartFromProblem({
  onAdded,
  onLeave,
}: {
  /** 登録したデータと, 開くタブ (まとめるの問題の設定から始めた群分けなど) */
  onAdded: (source: Source, tab?: ProblemStarted['tab']) => void
  /** 書き出しの画面へ移る前に呼ぶ (対話を閉じるなど) */
  onLeave?: () => void
}) {
  const api = useApi()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { project, onProjectChange } = useStage()
  return useMutation({
    mutationFn: (path: string) => api.startFromProblem(path),
    onSuccess: (result) => {
      // 置き場にある問題の設定だけを (場所で比べて) 知らせ, 殻の選びと同じなら知らせない
      // (行き来し続けないため)
      const id = problemIdOf(result.problem)
      const stored = queryClient.getQueryData<ProblemList>(['problems'])
      const known = stored?.problems.some((item) => item.path === result.problem) ?? false
      if (id !== null && known && id !== project) onProjectChange(id)
      if (result.source) {
        onAdded(result.source, result.tab)
        return
      }
      const search = new URLSearchParams({ form: result.form ?? '', problem: result.problem })
      onLeave?.()
      void navigate(`/datasets/export?${search.toString()}`)
    },
  })
}
