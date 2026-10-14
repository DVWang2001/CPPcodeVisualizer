// UML 物件圖教案 CC-2609B：n×n 矩陣的加、減、乘（用 new 配置一維陣列）
// （改寫自 CF 題目 CC-2609B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
using namespace std;
class matrix{
   int *data;
   int mn;
public:
   matrix(int n){
      mn=n;
      data=new int[n*n];
   }
   void read(){
      for(int i=0;i<mn*mn;i++)cin>>data[i];
   }
   void print(){
      for(int i=0;i<mn*mn;i++){
         if(i!=0 &&i%mn==0)cout<<endl;
         cout<<data[i]<<" ";
      }
      cout<<endl;
   }
   matrix add(matrix m){
      matrix result(mn);
      for(int i=0;i<mn*mn;i++)result.data[i]=data[i]+m.data[i];
      return result;
   }
   matrix sub(matrix m){
      matrix result(mn);
      for(int i=0;i<mn*mn;i++)result.data[i]=data[i]-m.data[i];
      return result;
   }
   matrix mul(matrix m){
      matrix result(mn);
      for(int i=0;i<mn;i++){
         for(int j=0;j<mn;j++){
            int sum=0;
            for(int k=0;k<mn;k++)sum+=data[i*mn+k]*m.data[k*mn+j];
            result.data[i*mn+j]=sum;
         }
      }
      return result;
   }
};
int main(){
   int n;
   cin>>n;
   matrix a(n);
   matrix b(n);
   a.read();b.read();
   a.add(b).print();cout<<endl;  //@ @guide uml:a
   a.sub(b).print();cout<<endl;
   a.mul(b).print();cout<<endl;
   return 0;
}
